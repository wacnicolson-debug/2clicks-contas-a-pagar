import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import { getOrCreateCompanySheetForYear } from "./getOrCreateCompanySheet";
import { PAID_LOG_TAB, RECEBIMENTOS_TAB, recebimentosMonthBlockRows } from "./provisionCompanySheet";
import { toBRDateString } from "@/lib/utils/formatDateBR";
import {
  APP_COLUMN_COUNT,
  columnLetter,
  isRowOccupied,
  readDayBlockLayout,
  rowMatchesTransaction,
} from "./dayBlockLayout";

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

  // Recebimento (Cliente/Receita) nunca teve lugar nas abas de mês — aquele
  // layout é todo pensado pra "quem eu tenho que pagar" (blocos de 30 linhas
  // por dia, coluna de forma de pagamento/pix do FORNECEDOR). Vai pra aba
  // "Recebimentos" própria, num formato de lista simples (sem bloco de dia).
  if (transaction.kind === "RECEIVABLE") {
    const year = transaction.dueDate.getUTCFullYear();
    const spreadsheetId = await getOrCreateCompanySheetForYear(transaction.companyId, year);
    const cellRef = await writeReceivableRow({
      companyId: transaction.companyId,
      spreadsheetId,
      year,
      transaction,
      googleRefreshToken,
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { sheetSyncStatus: "SYNCED", sheetCellRef: cellRef, costLogCellRef: null },
    });
    return;
  }

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

  const reservedRow0 = await reserveNextRowForDay({
    companyId: transaction.companyId,
    year,
    tabName: monthName,
    day,
  });

  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);

  // O contador só conhece o que o app gravou. Se o usuário digitou algo direto
  // na planilha nessa linha, pula pra próxima vazia em vez de gravar por cima;
  // e a coluna "Dia" pode não ser mais a A (colunas inseridas antes dela).
  const blockStart0 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY;
  const blockEnd0 = blockStart0 + ROWS_PER_DAY; // exclusivo
  const { offset, rows: currentBlock } = await readDayBlockLayout({
    sheets,
    spreadsheetId,
    tabName: monthName,
    blockStart1: blockStart0 + 1,
    blockEnd1: blockEnd0,
  });
  let rowIndex0 = reservedRow0;
  while (rowIndex0 < blockEnd0 && isRowOccupied(currentBlock[rowIndex0 - blockStart0], offset)) {
    rowIndex0++;
  }
  if (rowIndex0 >= blockEnd0) {
    throw new Error(
      `As ${ROWS_PER_DAY} linhas reservadas para o dia ${day} de ${monthName}/${year} já estão cheias.`
    );
  }
  if (rowIndex0 !== reservedRow0) {
    await prisma.sheetRowIndex.updateMany({
      where: {
        companyId: transaction.companyId,
        year,
        tabName: monthName,
        key: `day-${day}`,
        rowIndex: { lt: rowIndex0 + 1 },
      },
      data: { rowIndex: rowIndex0 + 1 },
    });
  }

  const rowValues = buildDayRowValues(transaction, costMonthDiffers);

  const row1Based = rowIndex0 + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${monthName}'!${columnLetter(offset)}${row1Based}:${columnLetter(offset + APP_COLUMN_COUNT - 1)}${row1Based}`,
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

type DayRowSource = {
  dueDate: Date;
  amount: unknown;
  paymentMethod: string | null;
  pixKey: string | null;
  description: string | null;
  supplier: { name: string };
  category: { name: string } | null;
};

function buildDayRowValues(t: DayRowSource, costMonthDiffers: boolean): (string | number)[] {
  return [
    t.dueDate.getUTCDate(),
    toBRDateString(t.dueDate),
    t.supplier.name,
    "",
    t.paymentMethod ? PAYMENT_METHOD_LABEL[t.paymentMethod] : "",
    t.pixKey ?? "",
    Number(t.amount),
    // Custo divergente do vencimento: deixa em branco aqui (senão conta 2x —
    // já é somado sob o mês certo no histórico oculto) — a linha ainda mostra
    // fornecedor/valor/data pra controle de pagamento.
    costMonthDiffers ? "" : t.category?.name ?? "",
    // Observação digitada pelo usuário (tela de perguntas ou Editar), se houver.
    t.description ?? "",
  ];
}

function buildReceivableRowValues(t: {
  dueDate: Date;
  amount: unknown;
  paid: boolean;
  description: string | null;
  supplier: { name: string };
  category: { name: string } | null;
}): (string | number)[] {
  const dueDateStr = toBRDateString(t.dueDate);
  const amount = Number(t.amount);
  return [
    dueDateStr,
    t.paid ? dueDateStr : "",
    t.supplier.name,
    "",
    t.category?.name ?? "",
    "",
    "",
    amount,
    t.paid ? amount : "",
    t.description ?? "",
  ];
}

function buildCostLogRowValues(p: {
  monthName: string;
  categoryName: string;
  amount: number;
  supplierName: string;
  date: Date;
  transactionId: string;
}): (string | number)[] {
  return [p.monthName, p.categoryName, p.amount, p.supplierName, p.date.toISOString().slice(0, 10), p.transactionId];
}

/**
 * Onde o lançamento fica na planilha. Dois estados com a mesma chave ocupam a
 * mesma linha — então uma correção (categoria, valor, observação...) pode ser
 * feita no lugar. Chave diferente (vencimento em outro dia, virou "pago"...)
 * significa que a linha precisa mudar de lugar.
 */
export function sheetDestinationKey(t: {
  kind: "PAYABLE" | "RECEIVABLE";
  dueDate: Date;
  noteDate: Date | null;
  paid: boolean;
  fromPaymentList: boolean;
}): string {
  const y = t.dueDate.getUTCFullYear();
  const m = t.dueDate.getUTCMonth();
  if (t.kind === "RECEIVABLE") return `recv:${y}-${m}`;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  if (t.paid && (t.fromPaymentList || t.dueDate >= startOfToday)) {
    return `log:${(t.noteDate ?? t.dueDate).getUTCFullYear()}`;
  }
  return `day:${y}-${m}-${t.dueDate.getUTCDate()}`;
}

export type ResyncResult =
  | { action: "exists"; tab: string; row: number }
  | { action: "in_log"; row: number }
  | { action: "created" };

/**
 * Ação explícita "Reenviar pra planilha" (separada do Editar, que nunca cria
 * linha): confere se o lançamento JÁ está na planilha e só grava se não
 * estiver. Se ele estiver no histórico oculto Custos Pagos mas o destino
 * certo é outra aba, não grava nada — guarda a posição pra o Editar conseguir
 * mover a mesma linha.
 */
export async function resyncTransactionToSheet(transactionId: string): Promise<ResyncResult> {
  const t = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { supplier: true, company: true, document: true },
  });
  const token = t.company.googleRefreshToken;
  if (!token) throw new Error("Empresa ainda não conectou o Google Sheets.");

  const key = sheetDestinationKey({
    kind: t.kind,
    dueDate: t.dueDate,
    noteDate: t.noteDate,
    paid: t.paid,
    fromPaymentList: t.document?.kind === "PAYMENT_LIST",
  });
  const amount = Number(t.amount);
  const { sheets } = getGoogleClientsForCompany(token);

  const setRef = async (ref: string) => {
    if (t.sheetCellRef !== ref) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { sheetCellRef: ref, sheetSyncStatus: "SYNCED" },
      });
    }
  };

  // 1) Histórico oculto de pagos — o id do lançamento fica na coluna F.
  const costYear = (t.noteDate ?? t.dueDate).getUTCFullYear();
  const costSheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId: t.companyId, year: costYear } },
  });
  if (costSheet) {
    const column = await sheets.spreadsheets.values.get({
      spreadsheetId: costSheet.spreadsheetId,
      range: `'${PAID_LOG_TAB}'!F1:F20000`,
    });
    const index = (column.data.values ?? []).findIndex((r) => String(r?.[0] ?? "") === t.id);
    if (index >= 0) {
      const row = index + 1;
      await setRef(`${PAID_LOG_TAB}!A${row}`);
      if (key.startsWith("log:")) return { action: "exists", tab: PAID_LOG_TAB, row };
      return { action: "in_log", row };
    }
  }

  // 2) Aba certa (bloco do dia ou mês de Recebimentos): procura por fornecedor + valor.
  const year = t.dueDate.getUTCFullYear();
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId: t.companyId, year } },
  });
  if (companySheet && (key.startsWith("day:") || key.startsWith("recv:"))) {
    const spreadsheetId = companySheet.spreadsheetId;
    let tab: string;
    let firstRow1: number;
    let rows: unknown[][];
    if (key.startsWith("recv:")) {
      const { dataStart0, dataEnd0 } = recebimentosMonthBlockRows(t.dueDate.getUTCMonth());
      tab = RECEBIMENTOS_TAB;
      firstRow1 = dataStart0 + 1;
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${RECEBIMENTOS_TAB}'!A${firstRow1}:J${dataEnd0}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      rows = (res.data.values ?? []) as unknown[][];
    } else {
      const day = t.dueDate.getUTCDate();
      tab = MONTHS[t.dueDate.getUTCMonth()];
      firstRow1 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY + 1;
      rows = (
        await readDayBlockLayout({
          sheets,
          spreadsheetId,
          tabName: tab,
          blockStart1: firstRow1,
          blockEnd1: firstRow1 + ROWS_PER_DAY - 1,
        })
      ).rows;
    }

    const matches = rows
      .map((row, i) => (rowMatchesTransaction(row, t.supplier.name, amount) ? i : -1))
      .filter((i) => i >= 0);
    // Lançamentos idênticos (mesmo fornecedor, valor e dia) precisam de uma
    // linha cada — só considera "já existe" se a planilha tem linhas pra todos.
    const twins = await prisma.transaction.count({
      where: {
        companyId: t.companyId,
        supplierId: t.supplierId,
        amount: t.amount,
        dueDate: t.dueDate,
        kind: t.kind,
      },
    });
    if (matches.length >= twins && matches.length > 0) {
      const row = firstRow1 + matches[0];
      await setRef(`${tab}!A${row}`);
      return { action: "exists", tab, row };
    }
  }

  await syncTransactionToSheet(t.id);
  return { action: "created" };
}

/**
 * A linha guardada no banco está na aba que o destino atual exige? Um
 * lançamento "a pagar" que ficou no histórico de pagos (ou o contrário) está
 * no lugar errado: corrigir "no lugar" só manteria o erro, então precisa mover.
 */
export function refMatchesDestination(sheetCellRef: string | null, destinationKey: string): boolean {
  if (!sheetCellRef) return true; // sem posição guardada: nada a comparar
  const tab = sheetCellRef.split("!")[0];
  if (destinationKey.startsWith("log:")) return tab === PAID_LOG_TAB;
  if (destinationKey.startsWith("recv:")) return tab === RECEBIMENTOS_TAB;
  return tab !== PAID_LOG_TAB && tab !== RECEBIMENTOS_TAB;
}

/**
 * Corrige a linha JÁ EXISTENTE do lançamento (mesmo lugar na planilha), em vez
 * de apagar e criar de novo. Confere que a linha guardada ainda é dele
 * (fornecedor + valor antigo; no histórico de pagos, pelo id) e, se a planilha
 * mudou por fora, procura no bloco a que bate. Devolve false se não achou —
 * aí quem chamou grava como nova (não há linha velha pra apagar).
 */
export async function updateTransactionRowInPlace(
  transactionId: string,
  previousAmount: number
): Promise<{ row: number } | null> {
  const t = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { supplier: true, category: true, company: true, document: true },
  });
  const token = t.company.googleRefreshToken;
  if (!token) return null;

  let tabName: string;
  let storedRow1: number | null = null;
  if (t.sheetCellRef) {
    const [tab, cell] = t.sheetCellRef.split("!");
    tabName = tab;
    storedRow1 = Number(cell?.match(/\d+/)?.[0]) || null;
  } else if (
    sheetDestinationKey({
      kind: t.kind,
      dueDate: t.dueDate,
      noteDate: t.noteDate,
      paid: t.paid,
      fromPaymentList: t.document?.kind === "PAYMENT_LIST",
    }).startsWith("day:")
  ) {
    // Sem posição guardada (ex: uma edição antiga falhou no meio) — procura a
    // linha no bloco do dia pelo conteúdo, em vez de gravar outra por cima.
    tabName = MONTHS[t.dueDate.getUTCMonth()];
  } else {
    return null;
  }
  if (tabName === PAID_LOG_TAB || tabName === RECEBIMENTOS_TAB) {
    if (!storedRow1) return null;
  }
  let resultRow = storedRow1 ?? 0;

  const costDate = t.noteDate ?? t.dueDate;
  const sheetYear = tabName === PAID_LOG_TAB ? costDate.getUTCFullYear() : t.dueDate.getUTCFullYear();
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId: t.companyId, year: sheetYear } },
  });
  if (!companySheet) return null;
  const spreadsheetId = companySheet.spreadsheetId;
  const { sheets } = getGoogleClientsForCompany(token);

  if (tabName === PAID_LOG_TAB) {
    const range = `'${PAID_LOG_TAB}'!A${storedRow1}:F${storedRow1}`;
    const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    if (String(current.data.values?.[0]?.[5] ?? "") !== t.id) return null;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          buildCostLogRowValues({
            monthName: MONTHS[costDate.getUTCMonth()],
            categoryName: t.category?.name ?? "",
            amount: Number(t.amount),
            supplierName: t.supplier.name,
            date: costDate,
            transactionId: t.id,
          }),
        ],
      },
    });
  } else if (tabName === RECEBIMENTOS_TAB) {
    const range = `'${RECEBIMENTOS_TAB}'!A${storedRow1}:J${storedRow1}`;
    const current = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    if (!rowMatchesTransaction(current.data.values?.[0], t.supplier.name, previousAmount)) return null;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [buildReceivableRowValues(t)] },
    });
  } else {
    const day = t.dueDate.getUTCDate();
    const blockStart1 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY + 1;
    const blockEnd1 = blockStart1 + ROWS_PER_DAY - 1;
    const { offset, rows } = await readDayBlockLayout({
      sheets,
      spreadsheetId,
      tabName,
      blockStart1,
      blockEnd1,
    });
    const storedIndex = storedRow1 ? storedRow1 - blockStart1 : -1;
    const index = rowMatchesTransaction(rows[storedIndex], t.supplier.name, previousAmount)
      ? storedIndex
      : rows.findIndex((row) => rowMatchesTransaction(row, t.supplier.name, previousAmount));
    if (index < 0) return null;
    const row1 = blockStart1 + index;
    resultRow = row1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!${columnLetter(offset)}${row1}:${columnLetter(offset + APP_COLUMN_COUNT - 1)}${row1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [buildDayRowValues(t, false)] },
    });
    if (row1 !== storedRow1) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { sheetCellRef: `${tabName}!A${row1}` },
      });
    }
  }

  await prisma.transaction.update({ where: { id: t.id }, data: { sheetSyncStatus: "SYNCED" } });
  return { row: resultRow };
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
  const rowValues = buildCostLogRowValues(params);

  await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: `'${PAID_LOG_TAB}'!A${row1Based}:F${row1Based}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });

  return `${PAID_LOG_TAB}!A${row1Based}`;
}

/**
 * Grava 1 linha na aba "Recebimentos" — lista simples (sem bloco de 30
 * linhas por dia como as abas de mês, cresce direto igual ao histórico de
 * custos pagos). "Data recebida" e "Valor recebido" só vêm preenchidos
 * quando o recebimento já foi marcado como Pago.
 */
async function writeReceivableRow(params: {
  companyId: string;
  spreadsheetId: string;
  year: number;
  transaction: {
    id: string;
    amount: unknown;
    dueDate: Date;
    paid: boolean;
    description: string | null;
    supplier: { name: string };
    category: { name: string } | null;
  };
  googleRefreshToken: string;
}): Promise<string> {
  const { transaction } = params;
  const rowIndex0 = await reserveNextRecebimentoRow({
    companyId: params.companyId,
    year: params.year,
    monthIndex0: transaction.dueDate.getUTCMonth(),
  });
  const row1Based = rowIndex0 + 1;

  const { sheets } = getGoogleClientsForCompany(params.googleRefreshToken);
  const rowValues = buildReceivableRowValues(transaction);

  await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: `'${RECEBIMENTOS_TAB}'!A${row1Based}:J${row1Based}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
  });

  return `${RECEBIMENTOS_TAB}!A${row1Based}`;
}

/**
 * Remove a linha da planilha correspondente a um lançamento excluído — e
 * COMPACTA o resto do bloco do dia pra cima, pra nunca deixar um "buraco"
 * na linha-resumo (a 1ª do dia, que fica visível mesmo com o grupo recolhido).
 * Sem isso, um lançamento real podia ficar escondido atrás de uma linha em
 * branco quando o item apagado era justamente o primeiro do dia.
 */
export async function clearTransactionFromSheet(transactionId: string): Promise<boolean> {
  const transaction = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { company: true, supplier: true },
  });

  if (!transaction.company.googleRefreshToken) {
    return false; // nunca conectou o Google, nada pra limpar
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
        const logRange = `'${PAID_LOG_TAB}'!A${rowNum}:F${rowNum}`;
        const logRow = await logSheets.spreadsheets.values.get({
          spreadsheetId: costSheet.spreadsheetId,
          range: logRange,
        });
        // Só limpa se a linha ainda é deste lançamento (o id fica na coluna F).
        if (String(logRow.data.values?.[0]?.[5] ?? "") === transaction.id) {
          await logSheets.spreadsheets.values.clear({
            spreadsheetId: costSheet.spreadsheetId,
            range: logRange,
          });
        }
      }
    }
  }

  if (!transaction.sheetCellRef) {
    return false; // nunca chegou a sincronizar a linha principal, nada mais pra limpar
  }

  const year = transaction.dueDate.getUTCFullYear();
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId: transaction.companyId, year } },
  });
  if (!companySheet) return false; // a planilha desse ano nem existe — nada pra limpar
  const spreadsheetId = companySheet.spreadsheetId;

  const [tabName, cell] = transaction.sheetCellRef.split("!");
  const deletedRow1Str = cell.match(/\d+/)?.[0];
  if (!deletedRow1Str) return false;
  const deletedRow1 = Number(deletedRow1Str);

  if (tabName === PAID_LOG_TAB) {
    // Histórico oculto não tem bloco de dia nem linha-resumo pra proteger —
    // a ordem das linhas não importa (só é somado por SOMASES), então basta
    // limpar a linha, sem compactar nada nem reindexar outras referências.
    const { sheets: sheetsClient } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);
    const logRange = `'${PAID_LOG_TAB}'!A${deletedRow1}:F${deletedRow1}`;
    const logRow = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: logRange });
    if (String(logRow.data.values?.[0]?.[5] ?? "") === transaction.id) {
      await sheetsClient.spreadsheets.values.clear({ spreadsheetId, range: logRange });
      return true;
    }
    return false;
  }

  if (tabName === RECEBIMENTOS_TAB) {
    // Mesmo raciocínio do histórico oculto — lista simples, sem bloco de dia
    // pra compactar.
    const { sheets: sheetsClient } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);
    const recvRange = `'${RECEBIMENTOS_TAB}'!A${deletedRow1}:J${deletedRow1}`;
    const recvRow = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: recvRange,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    if (
      rowMatchesTransaction(recvRow.data.values?.[0], transaction.supplier.name, Number(transaction.amount))
    ) {
      await sheetsClient.spreadsheets.values.clear({ spreadsheetId, range: recvRange });
      return true;
    }
    return false;
  }

  const day = transaction.dueDate.getUTCDate();
  const blockStart1 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY + 1;
  const blockEnd1 = blockStart1 + ROWS_PER_DAY - 1;

  const { sheets } = getGoogleClientsForCompany(transaction.company.googleRefreshToken);

  // Valor bruto (não "R$ 7.845,50" como texto, que o Sheets às vezes não
  // reconhece de volta como número ao regravar) e a coluna "Dia" achada pelo
  // cabeçalho — o usuário pode ter inserido colunas antes dela (ex: "Semana").
  const { offset, rows: currentRows } = await readDayBlockLayout({
    sheets,
    spreadsheetId,
    tabName,
    blockStart1,
    blockEnd1,
  });
  // Só as colunas do app (sempre 9, com "" nas vazias — uma linha mais curta
  // deixaria sobrando o conteúdo antigo daquela posição depois do deslocamento).
  const blockRows: (string | number)[][] = [];
  for (let i = 0; i < ROWS_PER_DAY; i++) {
    const source = currentRows[i] ?? [];
    blockRows.push(
      Array.from({ length: APP_COLUMN_COUNT }, (_, c) => {
        const value = source[offset + c];
        return value === undefined || value === null ? "" : (value as string | number);
      })
    );
  }

  // Confere se a linha guardada no banco ainda é MESMO deste lançamento
  // (fornecedor + valor). Se a planilha mudou por fora, procura no bloco a
  // linha que bate; se não achar nenhuma, não mexe em nada — apagar pela
  // posição velha tirava a linha de OUTRO lançamento e deixava esta duplicada.
  const storedIndex = deletedRow1 - blockStart1;
  const amountNumber = Number(transaction.amount);
  let deletedIndex = -1;
  if (rowMatchesTransaction(currentRows[storedIndex], transaction.supplier.name, amountNumber)) {
    deletedIndex = storedIndex;
  } else {
    deletedIndex = currentRows.findIndex((row) =>
      rowMatchesTransaction(row, transaction.supplier.name, amountNumber)
    );
  }
  if (deletedIndex < 0) {
    console.warn(
      `Lançamento ${transaction.id} (${transaction.supplier.name}) não encontrado no bloco do dia ${day} de ${tabName} — nada foi apagado da planilha.`
    );
    return false;
  }
  const actualDeletedRow1 = blockStart1 + deletedIndex;

  blockRows.splice(deletedIndex, 1);
  blockRows.push([day, "", "", "", "", "", "", "", ""]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!${columnLetter(offset)}${blockStart1}:${columnLetter(offset + APP_COLUMN_COUNT - 1)}${blockEnd1}`,
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
    if (r > actualDeletedRow1 && r <= blockEnd1) {
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
  return true;
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
 * Reserva a próxima linha livre dentro do bloco do mês na aba Recebimentos
 * (mesma ideia do reserveNextRowForDay, só que por mês em vez de por dia).
 */
async function reserveNextRecebimentoRow(params: {
  companyId: string;
  year: number;
  monthIndex0: number; // 0 = Janeiro .. 11 = Dezembro
}): Promise<number> {
  const { dataStart0, dataEnd0 } = recebimentosMonthBlockRows(params.monthIndex0);
  const key = `month-${params.monthIndex0}`;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sheetRowIndex.findUnique({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: RECEBIMENTOS_TAB,
          key,
        },
      },
    });

    const nextRow0 = existing ? existing.rowIndex : dataStart0;

    if (nextRow0 >= dataEnd0) {
      throw new Error(
        `As linhas reservadas para o mês ${params.monthIndex0 + 1} de Recebimentos/${params.year} já estão cheias.`
      );
    }

    await tx.sheetRowIndex.upsert({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: RECEBIMENTOS_TAB,
          key,
        },
      },
      create: {
        companyId: params.companyId,
        year: params.year,
        tabName: RECEBIMENTOS_TAB,
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
