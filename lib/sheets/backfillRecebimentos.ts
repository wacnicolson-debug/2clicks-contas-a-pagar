import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import {
  RECEBIMENTOS_TAB,
  RECEBIMENTOS_ROWS_PER_MONTH,
  buildRecebimentosValues,
  buildRecebimentosStructuralRequests,
  recebimentosMonthBlockRows,
} from "./provisionCompanySheet";
import { toBRDateString } from "@/lib/utils/formatDateBR";

/**
 * Reconstrói a aba Recebimentos de uma planilha já existente (criada antes
 * do agrupamento por mês/datas em padrão BR existirem — planilhas novas já
 * nascem certas, ver provisionCompanySheet.ts) a partir do banco, que é
 * quem manda na posição de cada lançamento. Reescreve a aba inteira (rótulos
 * de mês, linhas em branco e total) e recoloca cada Transaction no lugar
 * certo, atualizando o sheetCellRef dela — sem isso, uma exclusão futura
 * limparia a linha errada, já que a posição mudou.
 */
export async function rebuildRecebimentosTab(params: {
  companyId: string;
  spreadsheetId: string;
  year: number;
  googleRefreshToken: string;
}): Promise<{ transactionsPlaced: number }> {
  const { sheets } = getGoogleClientsForCompany(params.googleRefreshToken);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: params.spreadsheetId });
  const tab = meta.data.sheets?.find((s) => s.properties?.title === RECEBIMENTOS_TAB);
  if (!tab || tab.properties?.sheetId == null) {
    return { transactionsPlaced: 0 };
  }
  const sheetId = tab.properties.sheetId;
  // Já rodou uma vez nessa planilha (os agrupamentos de linha por mês já
  // existem) — recriar os mesmos grupos de novo dá erro na API do Sheets
  // ("grupo já existe nesse intervalo"), que travava a chamada inteira antes
  // até de chegar nas transações. Formatação só precisa rodar 1x; os valores
  // abaixo continuam idempotentes e são reescritos sempre.
  const alreadyStructured = (tab.rowGroups?.length ?? 0) > 0;

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId: params.companyId,
      kind: "RECEIVABLE",
      dueDate: {
        gte: new Date(Date.UTC(params.year, 0, 1)),
        lt: new Date(Date.UTC(params.year + 1, 0, 1)),
      },
    },
    include: { supplier: true, category: true },
    orderBy: { dueDate: "asc" },
  });

  const structure = buildRecebimentosValues(params.year);
  await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: structure.range!,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: structure.values },
  });
  if (!alreadyStructured) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: params.spreadsheetId,
      requestBody: { requests: buildRecebimentosStructuralRequests(sheetId) },
    });
  }

  const nextRowByMonth = new Map<number, number>();
  const cellUpdates: { range: string; values: (string | number)[][] }[] = [];
  const dbUpdates: { id: string; sheetCellRef: string }[] = [];

  for (const transaction of transactions) {
    const monthIndex0 = transaction.dueDate.getUTCMonth();
    const { dataStart0, dataEnd0 } = recebimentosMonthBlockRows(monthIndex0);
    const nextRow0 = nextRowByMonth.get(monthIndex0) ?? dataStart0;

    if (nextRow0 >= dataEnd0) {
      // Mais recebimentos naquele mês do que linhas reservadas — não deveria
      // acontecer com a folga atual (RECEBIMENTOS_ROWS_PER_MONTH), mas não
      // trava a migração inteira por causa de 1 mês muito cheio.
      console.error(
        `Mês ${monthIndex0 + 1}/${params.year} passou de ${RECEBIMENTOS_ROWS_PER_MONTH} recebimentos — transação ${transaction.id} ficou de fora da planilha.`
      );
      continue;
    }
    nextRowByMonth.set(monthIndex0, nextRow0 + 1);

    const row1Based = nextRow0 + 1;
    const dueDateStr = toBRDateString(transaction.dueDate);
    const amount = Number(transaction.amount);
    cellUpdates.push({
      range: `'${RECEBIMENTOS_TAB}'!A${row1Based}:J${row1Based}`,
      values: [
        [
          dueDateStr,
          transaction.paid ? dueDateStr : "",
          transaction.supplier.name,
          transaction.description ?? "",
          transaction.category?.name ?? "",
          "",
          "",
          amount,
          transaction.paid ? amount : "",
          "",
        ],
      ],
    });
    dbUpdates.push({ id: transaction.id, sheetCellRef: `${RECEBIMENTOS_TAB}!A${row1Based}` });
  }

  if (cellUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: params.spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: cellUpdates },
    });
  }

  for (const update of dbUpdates) {
    await prisma.transaction.update({
      where: { id: update.id },
      data: { sheetCellRef: update.sheetCellRef },
    });
  }

  // Realinha o contador de próxima linha livre de cada mês, pra próxima
  // sincronização (novo recebimento) continuar exatamente de onde a
  // reconstrução parou, em vez de sobrescrever o que acabou de ser colocado.
  for (const [monthIndex0, nextRow0] of nextRowByMonth.entries()) {
    await prisma.sheetRowIndex.upsert({
      where: {
        companyId_year_tabName_key: {
          companyId: params.companyId,
          year: params.year,
          tabName: RECEBIMENTOS_TAB,
          key: `month-${monthIndex0}`,
        },
      },
      create: {
        companyId: params.companyId,
        year: params.year,
        tabName: RECEBIMENTOS_TAB,
        key: `month-${monthIndex0}`,
        rowIndex: nextRow0,
      },
      update: { rowIndex: nextRow0 },
    });
  }

  return { transactionsPlaced: dbUpdates.length };
}
