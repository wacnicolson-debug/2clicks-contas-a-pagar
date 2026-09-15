import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import { getOrCreateCompanySheetForYear } from "./getOrCreateCompanySheet";
import { PAID_LOG_TAB } from "./provisionCompanySheet";

const ROWS_PER_DAY = 30;
const HEADER_ROWS = 2; // título + cabeçalho, 0-based -> primeira linha de dado = índice 2

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  BOLETO: "BOLETO",
  PIX: "PIX",
  DEBITO_CONTA: "DÉBITO EM CONTA",
};

/**
 * Sincroniza 1 lançamento (Transaction) já salvo no banco com a linha certa
 * da planilha viva da empresa. O Postgres é quem decide "em que linha" —
 * a planilha nunca é lida de volta pra descobrir posição (ver SheetRowIndex).
 * A planilha certa é escolhida (e criada, se ainda não existir) pelo ANO do
 * vencimento — cada ano tem sua própria planilha.
 */
export async function syncTransactionToSheet(transactionId: string): Promise<void> {
  const transaction = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { supplier: true, category: true, company: true, document: true },
  });

  if (!transaction.company.googleRefreshToken) {
    throw new Error(
      `Empresa ${transaction.companyId} ainda não conectou o Google Sheets.`
    );
  }
  const googleRefreshToken = transaction.company.googleRefreshToken;

  const dueDate = transaction.dueDate;
  // Mês que o custo/receita conta na Classificação de Custos — o vencimento,
  // a menos que a nota tenha uma data real diferente (compra/venda antiga
  // lançada com atraso, prazo longo). Ver Transaction.noteDate no schema.
  const costDate = transaction.noteDate ?? dueDate;
  const costMonthDiffers =
    costDate.getUTCFullYear() !== dueDate.getUTCFullYear() ||
    costDate.getUTCMonth() !== dueDate.getUTCMonth();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const alreadyOverdue = dueDate < startOfToday;
  // Lançamento vindo da "Relação de Pagamentos" (boletos/pix já pagos,
  // importados em lote pra apurar custo de um período fechado) nunca deve
  // ocupar linha na aba do mês — essa aba é a lista operacional de quem
  // ainda vai pagar, e esse pagamento já é passado/fechado. Só entra no
  // histórico oculto de custos, senão duplica contra o que já foi
  // controlado manualmente na planilha (ou no fluxo normal) daquele mês.
  const fromPaymentList = transaction.document?.kind === "PAYMENT_LIST";

  if (transaction.paid && (fromPaymentList || !alreadyOverdue)) {
    // Paga ANTES do vencimento (adiantada) não é mais "a pagar" — não ocupa
    // linha no fluxo de pagamentos do mês, só entra no histórico oculto que
    // alimenta a Classificação de Custos (sob o mês de costDate). Já vencida
    // é diferente: o usuário quer ver na linha do dia mesmo, porque paga as
    // contas 1 por 1 olhando pra planilha e marca manualmente (cor da linha)
    // o que já pagou — ver memória do projeto.
    const costYear = costDate.getUTCFullYear();
    const costSpreadsheetId = await getOrCreateCompanySheetForYear(transaction.companyId, costYear);
    const logCellRef = await writeCostLogEntry({
      companyId: transaction.companyId,
      spreadsheetId: costSpreadsheetId,
      year: costYear,
      monthName: MONTHS[costDate.getUTCMonth()],
      categoryName: transaction.category?.name ?? "",
      amount: Number(transaction.amount),
      supplierName: transaction.supplier.name,
      date: costDate,
      transactionId: transaction.id,
      googleRefreshToken,
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { sheetSyncStatus: "SYNCED", sheetCellRef: logCellRef, costLogCellRef: null },
    });
    return;
  }

  const year = dueDate.getUTCFullYear();
  const monthName = MONTHS[dueDate.getUTCMonth()];
  const day = dueDate.getUTCDate();
  const spreadsheetId = await getOrCreateCompanySheetForYear(transaction.companyId, year);

  const rowIndex0 = await reserveNextRowForDay({
    companyId: transaction.companyId,
    year,
    tabName: monthName,
    day,
  });

  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);
  const rowValues = [
    day,
    dueDate.toISOString().slice(0, 10),
    transaction.supplier.name,
    transaction.description ?? "",
    transaction.paymentMethod ? PAYMENT_METHOD_LABEL[transaction.paymentMethod] : "",
    transaction.pixKey ?? "",
    Number(transaction.amount),
    // Custo divergente do vencimento: deixa em branco aqui (senão conta 2x —
    // já é somado sob o mês certo no histórico oculto, logo abaixo) — a
    // linha ainda mostra fornecedor/valor/data pra controle de pagamento.
    costMonthDiffers ? "" : transaction.category?.name ?? "",
    "",
  ];

  const row1Based = rowIndex0 + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${monthName}'!A${row1Based}:I${row1Based}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });

  let costLogCellRef: string | null = null;
  if (costMonthDiffers) {
    const costYear = costDate.getUTCFullYear();
    const costSpreadsheetId = await getOrCreateCompanySheetForYear(transaction.companyId, costYear);
    costLogCellRef = await writeCostLogEntry({
      companyId: transaction.companyId,
      spreadsheetId: costSpreadsheetId,
      year: costYear,
      monthName: MONTHS[costDate.getUTCMonth()],
      categoryName: transaction.category?.name ?? "",
      amount: Number(transaction.amount),
      supplierName: transaction.supplier.name,
      date: costDate,
      transactionId: transaction.id,
      googleRefreshToken,
    });
  }

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      sheetSyncStatus: "SYNCED",
      sheetCellRef: `${monthName}!A${row1Based}`,
      costLogCellRef,
    },
  });
}

/**
 * Grava 1 linha no histórico oculto que alimenta a Classificação de Custos —
 * usado tanto pra lançamento pago adiantado (sem linha no bloco do dia)
 * quanto pra custo de mês diferente do vencimento (com linha no bloco do dia
 * também, mas sem contar 2x). Devolve a referência da linha gravada; quem
 * chama decide em qual campo do Transaction guardar (sheetCellRef ou
 * costLogCellRef, conforme o caso).
 */
async function writeCostLogEntry(params: {
  companyId: string;
  spreadsheetId: string;
  year: number;
  monthName: string;
  categoryName: string;
  amount: number;
  supplierName: string;
  date: Date;
  transactionId: string;
  googleRefreshToken: string;
}): Promise<string> {
  const rowIndex0 = await reserveNextLogRow({
    companyId: params.companyId,
    year: params.year,
    tabName: PAID_LOG_TAB,
  });
  const row1Based = rowIndex0 + 1;

  const { sheets } = getGoogleClientsForCompany(params.googleRefreshToken);
  const rowValues = [
    params.monthName,
    params.categoryName,
    params.amount,
    params.supplierName,
    params.date.toISOString().slice(0, 10),
    params.transactionId,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: `'${PAID_LOG_TAB}'!A${row1Based}:F${row1Based}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });

  return `${PAID_LOG_TAB}!A${row1Based}`;
}

/**
 * Remove a linha da planilha correspondente a um lançamento excluído — e
 * COMPACTA o resto do bloco do dia pra cima, pra nunca deixar um "buraco"
 * na linha-resumo (a 1ª do dia, que fica visível mesmo com o grupo recolhido).
 * Sem isso, um lançamento real podia ficar escondido atrás de uma linha em
 * branco quando o item apagado era justamente o primeiro do dia.
 */
export async function clearTransactionFromSheet(transactionId: string): Promise<void> {
  const transaction = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { company: true },
  });

  if (!transaction.company.googleRefreshToken) {
    return; // nunca conectou o Google, nada pra limpar
  }

  // Custo de mês diferente do vencimento grava uma linha EXTRA no histórico
  // oculto (além da linha normal no bloco do dia) — limpa essa linha à parte,
  // independente do resto da função (que trata só a linha do bloco do dia).
  if (transaction.costLogCellRef) {
    const costDate = transaction.noteDate ?? transaction.dueDate;
    const costYear = costDate.getUTCFullYear();
    const costSheet = await prisma.companySheet.findUnique({
      where: { companyId_year: { companyId: transaction.companyId, year: costYear } },
    });
    if (costSheet) {
      const cell = transaction.costLogCellRef.split("!")[1];
      const rowNum = cell.match(/\d+/)?.[0];
      if (rowNum) {
        const { sheets: logSheets } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);
        await logSheets.spreadsheets.values.clear({
          spreadsheetId: costSheet.spreadsheetId,
          range: `'${PAID_LOG_TAB}'!A${rowNum}:F${rowNum}`,
        });
      }
    }
  }

  if (!transaction.sheetCellRef) {
    return; // nunca chegou a sincronizar a linha principal, nada mais pra limpar
  }

  const year = transaction.dueDate.getUTCFullYear();
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId: transaction.companyId, year } },
  });
  if (!companySheet) return; // a planilha desse ano nem existe — nada pra limpar
  const spreadsheetId = companySheet.spreadsheetId;

  const [tabName, cell] = transaction.sheetCellRef.split("!");
  const deletedRow1Str = cell.match(/\d+/)?.[0];
  if (!deletedRow1Str) return;
  const deletedRow1 = Number(deletedRow1Str);

  if (tabName === PAID_LOG_TAB) {
    // Histórico oculto não tem bloco de dia nem linha-resumo pra proteger —
    // a ordem das linhas não importa (só é somado por SOMASES), então basta
    // limpar a linha, sem compactar nada nem reindexar outras referências.
    const { sheets: sheetsClient } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${PAID_LOG_TAB}'!A${deletedRow1}:F${deletedRow1}`,
    });
    return;
  }

  const day = transaction.dueDate.getUTCDate();
  const blockStart1 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY + 1;
  const blockEnd1 = blockStart1 + ROWS_PER_DAY - 1;

  const { sheets } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);

  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A${blockStart1}:I${blockEnd1}`,
  });
  const blockRows = current.data.values ?? [];
  while (blockRows.length < ROWS_PER_DAY) blockRows.push([]);

  const deletedIndex = deletedRow1 - blockStart1;
  if (deletedIndex >= 0 && deletedIndex < blockRows.length) {
    blockRows.splice(deletedIndex, 1);
  }
  blockRows.push([day, "", "", "", "", "", "", "", ""]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A${blockStart1}:I${blockEnd1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: blockRows },
  });

  // Os lançamentos que estavam abaixo do excluído, dentro do mesmo bloco (e
  // mesmo ano), subiram 1 linha — atualiza a referência deles pra não apontar
  // errado numa exclusão futura.
  const affected = await prisma.transaction.findMany({
    where: {
      companyId: transaction.companyId,
      id: { not: transaction.id },
      sheetCellRef: { startsWith: `${tabName}!A` },
      dueDate: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    },
    select: { id: true, sheetCellRef: true },
  });
  for (const t of affected) {
    const r = Number(t.sheetCellRef?.match(/\d+/)?.[0]);
    if (r > deletedRow1 && r <= blockEnd1) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { sheetCellRef: `${tabName}!A${r - 1}` },
      });
    }
  }

  // Libera de volta 1 linha no contador do dia (a última ficou em branco).
  await prisma.sheetRowIndex.updateMany({
    where: { companyId: transaction.companyId, year, tabName, key: `day-${day}` },
    data: { rowIndex: { decrement: 1 } },
  });
}

/**
 * Reserva (e avança) a próxima linha livre dentro do bloco de 30 linhas do dia,
 * de forma transacional para não haver duas gravações competindo pela mesma linha.
 */
async function reserveNextRowForDay(params: {
  companyId: string;
  year: number;
  tabName: string;
  day: number;
}): Promise<number> {
  const key = `day-${params.day}`;
  const blockStart0 = HEADER_ROWS + (params.day - 1) * ROWS_PER_DAY;
  const blockEnd0 = blockStart0 + ROWS_PER_DAY; // exclusivo

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sheetRowIndex.findUnique({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: params.tabName,
          key,
        },
      },
    });

    const nextRow0 = existing ? existing.rowIndex : blockStart0;

    if (nextRow0 >= blockEnd0) {
      throw new Error(
        `As 30 linhas reservadas para o dia ${params.day} de ${params.tabName}/${params.year} já estão cheias.`
      );
    }

    await tx.sheetRowIndex.upsert({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: params.tabName,
          key,
        },
      },
      create: {
        companyId: params.companyId,
        year: params.year,
        tabName: params.tabName,
        key,
        rowIndex: nextRow0 + 1,
      },
      update: { rowIndex: nextRow0 + 1 },
    });

    return nextRow0;
  });
}

/**
 * Reserva a próxima linha livre do histórico oculto de pagos — cresce sem
 * limite (não tem bloco fixo de 30 linhas como os dias, é só um log).
 */
async function reserveNextLogRow(params: {
  companyId: string;
  year: number;
  tabName: string;
}): Promise<number> {
  const key = "log";

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sheetRowIndex.findUnique({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: params.tabName,
          key,
        },
      },
    });

    const nextRow0 = existing ? existing.rowIndex : HEADER_ROWS;

    await tx.sheetRowIndex.upsert({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: params.tabName,
          key,
        },
      },
      create: {
        companyId: params.companyId,
        year: params.year,
        tabName: params.tabName,
        key,
        rowIndex: nextRow0 + 1,
      },
      update: { rowIndex: nextRow0 + 1 },
    });

    return nextRow0;
  });
}

const MONTHS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
