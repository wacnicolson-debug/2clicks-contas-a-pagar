import type { sheets_v4 } from "googleapis";
import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";

export const COMPRAS_TAB = "Compras";
export const ESTOQUE_TAB = "Estoque";

// Colunas A.. de cada aba. A última (ID) fica oculta: é por ela que o app
// acha as linhas de uma nota pra apagar, mesmo se a planilha for reordenada.
export const COMPRAS_HEADERS = [
  "Mês",
  "Data da nota",
  "Fornecedor",
  "Nº da nota",
  "Categoria",
  "Valor total da nota",
  "Parcelas",
  "Observação",
  "ID",
];
export const ESTOQUE_HEADERS = [
  "Mês",
  "Data da nota",
  "Fornecedor",
  "Nº da nota",
  "Categoria",
  "Item",
  "Qtd",
  "Un",
  "Valor unitário",
  "Valor do item",
  "Observação",
  "ID",
];

const MAX_ROWS = 20000;

function monthLabel(i: number): string {
  return MONTHS[i];
}

/** Resumo mensal fixo ao lado da tabela (colunas N a R), uma linha por mês. */
export function summaryValues(tab: typeof COMPRAS_TAB | typeof ESTOQUE_TAB): (string | number)[][] {
  const valueCol = tab === COMPRAS_TAB ? "F" : "J";
  const catCol = "E";
  const rows: (string | number)[][] = [];
  rows.push(["Resumo por mês", "", "", "", ""]);
  rows.push([
    "Mês",
    tab === COMPRAS_TAB ? "Total das notas" : "Total dos itens",
    "Tecidos",
    "Aviamentos",
    "Produtos químicos",
  ]);
  for (let i = 0; i < 12; i++) {
    const r = i + 3;
    rows.push([
      monthLabel(i),
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r})`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*tecido*")`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*aviamento*")`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*qu?mic*")`,
    ]);
  }
  rows.push(["Ano", "=SUM(O3:O14)", "=SUM(P3:P14)", "=SUM(Q3:Q14)", "=SUM(R3:R14)"]);
  return rows;
}

/** Formatação do resumo mensal ao lado da tabela (colunas N a R). */
export function summaryFormatRequests(sheetId: number): sheets_v4.Schema$Request[] {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 13, endColumnIndex: 18 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: { red: 0.16, green: 0.28, blue: 0.24 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 13, endColumnIndex: 18 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 15, startColumnIndex: 14, endColumnIndex: 18 },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 14, endRowIndex: 15, startColumnIndex: 13, endColumnIndex: 18 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
  ];
}

function tabRequests(sheetId: number, tab: typeof COMPRAS_TAB | typeof ESTOQUE_TAB): sheets_v4.Schema$Request[] {
  const headers = tab === COMPRAS_TAB ? COMPRAS_HEADERS : ESTOQUE_HEADERS;
  const money = tab === COMPRAS_TAB ? [5] : [8, 9];
  const reqs: sheets_v4.Schema$Request[] = [
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
        mergeType: "MERGE_ALL",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: { red: 0.16, green: 0.28, blue: 0.24 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: headers.length },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: headers.length } } } },
    // Data da nota (B)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // ID oculto
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: headers.length - 1, endIndex: headers.length },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    },
    ...summaryFormatRequests(sheetId),
  ];
  for (const col of money) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  if (tab === ESTOQUE_TAB) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 6, endColumnIndex: 7 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  const widths: Record<number, number> = tab === COMPRAS_TAB ? { 0: 90, 1: 95, 2: 280, 3: 110, 4: 190, 5: 130, 6: 70, 7: 260 } : { 0: 90, 1: 95, 2: 260, 3: 110, 4: 150, 5: 330, 6: 80, 7: 50, 8: 110, 9: 110, 10: 240 };
  for (const [col, px] of Object.entries(widths)) {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: Number(col), endIndex: Number(col) + 1 },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  }
  reqs.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: 13, endIndex: 18 },
      properties: { pixelSize: 125 },
      fields: "pixelSize",
    },
  });
  return reqs;
}

export async function provisionStockSheet(
  companyName: string,
  googleRefreshToken: string,
  year: number
): Promise<string> {
  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Compras e Estoque — ${companyName} — ${year}`, locale: "pt_BR" },
      sheets: [{ properties: { title: COMPRAS_TAB } }, { properties: { title: ESTOQUE_TAB } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Falha ao criar a planilha de Compras e Estoque");
  const idOf = (title: string) =>
    created.data.sheets?.find((s) => s.properties?.title === title)?.properties?.sheetId as number;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `'${COMPRAS_TAB}'!A1`, values: [[`COMPRAS ${year} — toda nota lançada, pelo valor total da nota`]] },
        { range: `'${COMPRAS_TAB}'!A2`, values: [COMPRAS_HEADERS] },
        { range: `'${COMPRAS_TAB}'!N1`, values: summaryValues(COMPRAS_TAB) },
        { range: `'${ESTOQUE_TAB}'!A1`, values: [[`ESTOQUE ${year} — só matéria-prima (tecidos e aviamentos) e produtos químicos, item a item`]] },
        { range: `'${ESTOQUE_TAB}'!A2`, values: [ESTOQUE_HEADERS] },
        { range: `'${ESTOQUE_TAB}'!N1`, values: summaryValues(ESTOQUE_TAB) },
      ],
    },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [...tabRequests(idOf(COMPRAS_TAB), COMPRAS_TAB), ...tabRequests(idOf(ESTOQUE_TAB), ESTOQUE_TAB)] },
  });
  return spreadsheetId;
}

/** Planilha de Compras e Estoque do ano — criada sozinha na primeira nota do ano. */
export async function getOrCreateStockSheetForYear(companyId: string, year: number): Promise<string> {
  const existing = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId, year } } });
  if (existing) return existing.spreadsheetId;

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!company.googleRefreshToken) {
    throw new Error(`Empresa ${companyId} ainda não conectou o Google Sheets.`);
  }
  // Trava por empresa+ano: duas notas chegando juntas não podem criar duas
  // planilhas (a segunda esperaria e já acharia a primeira).
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stocksheet:${companyId}:${year}`}))`;
      const again = await tx.stockSheet.findUnique({ where: { companyId_year: { companyId, year } } });
      if (again) return again.spreadsheetId;
      const spreadsheetId = await provisionStockSheet(company.name, company.googleRefreshToken!, year);
      await tx.stockSheet.create({ data: { companyId, year, spreadsheetId } });
      return spreadsheetId;
    },
    { timeout: 120000, maxWait: 60000 }
  );
}
