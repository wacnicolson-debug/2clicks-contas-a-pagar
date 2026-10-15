import type { sheets_v4 } from "googleapis";
import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";

export const ESTOQUE_TAB = "Estoque";
export const ITENS_TAB = "Itens";

// Planilha de COMPRAS: uma aba por mês, só notas fiscais, em ordem de emissão.
// Pensada pra digitar a nota no Alterdata Fiscal: as 4 primeiras colunas são as
// que a contabilidade pediu e as seguintes seguem a ordem da lista de notas de
// entrada do Fiscal (espécie, série, modelo, número, ICMS...). "Entrada" fica em
// branco pra quem digita. A última (ID) fica oculta: é por ela que o app acha as
// linhas de uma nota pra apagar ou mover, mesmo se a planilha for reordenada.
export const COMPRAS_HEADERS = [
  "Emissão",
  "Fornecedor",
  "CFOP",
  "Valor contábil",
  "Entrada",
  "Espécie",
  "Série",
  "Modelo",
  "Número",
  "Base ICMS",
  "% ICMS",
  "Valor ICMS",
  "IPI",
  "Frete",
  "CNPJ do fornecedor",
  "Chave de acesso",
  "Categoria",
  "Observação",
  "Lanç. automático",
  "Lançado",
  "ID",
];
export const COMPRAS_TABLE_COLS = COMPRAS_HEADERS.length; // A..U
// Resumo do mês ao lado da tabela: colunas X (rótulo) e Y (valor).
const SUM_LABEL_COL = 23;

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
  "Item padrão",
  "ID",
];

// Aba Itens: uma linha por item padrão, com última compra, variação e média dos
// últimos 3 meses. Reescrita inteira pelo app a cada nota de estoque.
export const ITENS_HEADERS = [
  "Item",
  "Tipo",
  "Un",
  "Genérico",
  "Última compra",
  "Fornecedor (última)",
  "Qtd (última)",
  "Último preço",
  "Preço anterior",
  "Fornecedor (anterior)",
  "Variação",
  "Preço médio 3 meses",
  "Qtd 3 meses",
  "Total 3 meses",
  "Menor preço 3m",
  "Maior preço 3m",
  "Nº de compras",
];

const MAX_ROWS = 20000;
const GREEN = { red: 0.16, green: 0.28, blue: 0.24 };
const GREY = { red: 0.85, green: 0.85, blue: 0.85 };

export function isMonthTab(tab: string): boolean {
  return (MONTHS as readonly string[]).includes(tab);
}

/** Resumo mensal fixo ao lado da tabela do Estoque (colunas N a R), uma linha por mês. */
export function summaryValues(): (string | number)[][] {
  const valueCol = "J";
  const catCol = "E";
  const rows: (string | number)[][] = [];
  rows.push(["Resumo por mês", "", "", "", ""]);
  rows.push(["Mês", "Total dos itens", "Tecidos", "Aviamentos", "Produtos químicos"]);
  for (let i = 0; i < 12; i++) {
    const r = i + 3;
    rows.push([
      MONTHS[i],
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r})`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*tecido*")`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*aviamento*")`,
      `=SUMIFS($${valueCol}:$${valueCol};$A:$A;$N${r};$${catCol}:$${catCol};"*qu?mic*")`,
    ]);
  }
  rows.push(["Ano", "=SUM(O3:O14)", "=SUM(P3:P14)", "=SUM(Q3:Q14)", "=SUM(R3:R14)"]);
  return rows;
}

/** Formatação do resumo mensal ao lado da tabela do Estoque (colunas N a R). */
export function summaryFormatRequests(sheetId: number): sheets_v4.Schema$Request[] {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 13, endColumnIndex: 18 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: GREEN } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 13, endColumnIndex: 18 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: GREY } },
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

function widthRequests(sheetId: number, widths: Record<number, number>): sheets_v4.Schema$Request[] {
  return Object.entries(widths).map(([col, px]) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: Number(col), endIndex: Number(col) + 1 },
      properties: { pixelSize: px },
      fields: "pixelSize",
    },
  }));
}

function moneyFormat(sheetId: number, col: number): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
      fields: "userEnteredFormat.numberFormat",
    },
  };
}

function textFormat(sheetId: number, col: number): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
      fields: "userEnteredFormat.numberFormat",
    },
  };
}

/** Valores fixos de uma aba de mês: título, cabeçalho e resumo do mês ao lado. */
export function monthTabValues(monthIndex: number, year: number): { range: string; values: (string | number)[][] }[] {
  const tab = MONTHS[monthIndex];
  return [
    { range: `'${tab}'!A1`, values: [[`${tab.toUpperCase()} ${year} — NOTAS FISCAIS DE COMPRA (em ordem de emissão)`]] },
    { range: `'${tab}'!A2`, values: [COMPRAS_HEADERS] },
    {
      range: `'${tab}'!X1`,
      values: [
        ["Resumo do mês", ""],
        ["Total das notas", "=SUM($D$3:$D)"],
        ["Nº de notas", "=COUNTA($B$3:$B)"],
        ["Lançadas no Alterdata", "=COUNTIF($T$3:$T;TRUE)"],
        ["Tecidos", '=SUMIFS($D$3:$D;$Q$3:$Q;"*tecido*")'],
        ["Aviamentos", '=SUMIFS($D$3:$D;$Q$3:$Q;"*aviamento*")'],
        ["Produtos químicos", '=SUMIFS($D$3:$D;$Q$3:$Q;"*qu?mic*")'],
      ],
    },
  ];
}

export function monthTabRequests(sheetId: number): sheets_v4.Schema$Request[] {
  const n = COMPRAS_TABLE_COLS;
  const dateFmt = (col: number): sheets_v4.Schema$Request => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
  const sumCol = SUM_LABEL_COL;
  return [
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n }, mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: GREEN } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: n },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: GREY } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: n } } } },
    dateFmt(0), // Emissão
    dateFmt(4), // Entrada
    // CFOP, série, modelo, número, CNPJ e chave são identificadores: ficam como texto
    // (senão a planilha come zeros à esquerda e troca a chave por notação científica).
    ...[2, 6, 7, 8, 14, 15, 18].map((c) => textFormat(sheetId, c)),
    ...[3, 9, 11, 12, 13].map((c) => moneyFormat(sheetId, c)),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 10, endColumnIndex: 11 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0.00" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // Lançado: caixinha pra marcar a nota já digitada no Alterdata
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 19, endColumnIndex: 20 },
        rule: { condition: { type: "BOOLEAN" }, strict: true },
      },
    },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: n - 1, endIndex: n }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
    ...widthRequests(sheetId, { 0: 95, 1: 280, 2: 65, 3: 115, 4: 95, 5: 65, 6: 55, 7: 65, 8: 90, 9: 105, 10: 70, 11: 105, 12: 85, 13: 85, 14: 150, 15: 330, 16: 190, 17: 300, 18: 100, 19: 70, 21: 30, 23: 160, 24: 120 }),
    // resumo do mês (X:Y)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: sumCol, endColumnIndex: sumCol + 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: GREEN } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 7, startColumnIndex: sumCol, endColumnIndex: sumCol + 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 7, startColumnIndex: sumCol + 1, endColumnIndex: sumCol + 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 4, startColumnIndex: sumCol + 1, endColumnIndex: sumCol + 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
  ];
}

const PRICE_PATTERN = '"R$" #,##0.00##';

function itensRequests(sheetId: number): sheets_v4.Schema$Request[] {
  const n = ITENS_HEADERS.length;
  const fmt = (col: number, type: string, pattern: string): sheets_v4.Schema$Request => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
  return [
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n }, mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: GREEN } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: n },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: GREY, wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat(textFormat,backgroundColor,wrapStrategy)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: n } } } },
    fmt(4, "DATE", "dd/mm/yyyy"),
    fmt(6, "NUMBER", "#,##0.00"),
    fmt(7, "CURRENCY", PRICE_PATTERN),
    fmt(8, "CURRENCY", PRICE_PATTERN),
    fmt(10, "PERCENT", "0.0%"),
    fmt(11, "CURRENCY", PRICE_PATTERN),
    fmt(12, "NUMBER", "#,##0.00"),
    fmt(13, "CURRENCY", '"R$" #,##0.00'),
    fmt(14, "CURRENCY", PRICE_PATTERN),
    fmt(15, "CURRENCY", PRICE_PATTERN),
    ...widthRequests(sheetId, { 0: 300, 1: 130, 2: 50, 3: 80, 4: 100, 5: 230, 6: 90, 7: 105, 8: 105, 9: 230, 10: 80, 11: 120, 12: 95, 13: 110, 14: 105, 15: 105, 16: 90 }),
  ];
}

export function itensValues(year: number): { range: string; values: (string | number)[][] }[] {
  return [
    { range: `'${ITENS_TAB}'!A1`, values: [[`ITENS ${year} — último preço, variação e preço médio dos últimos 3 meses por item (atualiza a cada nota)`]] },
    { range: `'${ITENS_TAB}'!A2`, values: [ITENS_HEADERS] },
  ];
}

function estoqueRequests(sheetId: number): sheets_v4.Schema$Request[] {
  const n = ESTOQUE_HEADERS.length;
  return [
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n }, mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: GREEN } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: n },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: GREY } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: n } } } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // (a coluna do ID já foi a L; desoculta caso a planilha seja de antes do "Item padrão")
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 11, endIndex: 12 }, properties: { hiddenByUser: false }, fields: "hiddenByUser" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: n - 1, endIndex: n }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
    ...summaryFormatRequests(sheetId),
    moneyFormat(sheetId, 8),
    moneyFormat(sheetId, 9),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 6, endColumnIndex: 7 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    ...widthRequests(sheetId, { 0: 90, 1: 95, 2: 260, 3: 110, 4: 150, 5: 330, 6: 80, 7: 50, 8: 110, 9: 110, 10: 240, 11: 260, 13: 125, 14: 125, 15: 125, 16: 125, 17: 125 }),
  ];
}

export function estoqueValues(year: number): { range: string; values: (string | number)[][] }[] {
  return [
    { range: `'${ESTOQUE_TAB}'!A1`, values: [[`ESTOQUE ${year} — só matéria-prima (tecidos e aviamentos) e produtos químicos, item a item`]] },
    { range: `'${ESTOQUE_TAB}'!A2`, values: [ESTOQUE_HEADERS] },
    { range: `'${ESTOQUE_TAB}'!N1`, values: summaryValues() },
  ];
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
      sheets: [...MONTHS.map((m) => ({ properties: { title: m } })), { properties: { title: ESTOQUE_TAB } }, { properties: { title: ITENS_TAB } }],
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
      data: [...MONTHS.flatMap((_, i) => monthTabValues(i, year)), ...estoqueValues(year), ...itensValues(year)],
    },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [...MONTHS.flatMap((m) => monthTabRequests(idOf(m))), ...estoqueRequests(idOf(ESTOQUE_TAB)), ...itensRequests(idOf(ITENS_TAB))],
    },
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

/**
 * Leva uma planilha criada no formato antigo (uma aba "Compras" só) pro formato
 * novo: 12 abas de mês e o Estoque com o resumo próprio. Usada uma vez.
 */
export async function migrateStockSheetToMonthTabs(
  spreadsheetId: string,
  googleRefreshToken: string,
  year: number,
  opts: { recreateMonths?: boolean } = {}
): Promise<void> {
  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const titles = new Map((meta.data.sheets ?? []).map((s) => [s.properties!.title!, s.properties!.sheetId!]));

  // O formato das abas de mês mudou: apaga as existentes e recria (só vale pra planilha sem notas ainda).
  const stale = MONTHS.filter((m) => titles.has(m));
  if (stale.length && opts.recreateMonths) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: stale.map((m) => ({ deleteSheet: { sheetId: titles.get(m)! } })) },
    });
    stale.forEach((m) => titles.delete(m));
  }
  if (!titles.has(ITENS_TAB)) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ITENS_TAB } } }] },
    });
    titles.set(ITENS_TAB, res.data.replies![0].addSheet!.properties!.sheetId!);
  }
  const missing = MONTHS.filter((m) => !titles.has(m));
  if (missing.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: missing.map((m) => ({ addSheet: { properties: { title: m, index: MONTHS.indexOf(m) } } })) },
    });
    res.data.replies?.forEach((r, i) => {
      if (r.addSheet?.properties) titles.set(missing[i], r.addSheet.properties.sheetId!);
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: [...MONTHS.flatMap((_, i) => monthTabValues(i, year)), ...estoqueValues(year), ...itensValues(year)] },
  });
  const estoqueId = titles.get(ESTOQUE_TAB)!;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [...MONTHS.flatMap((m) => monthTabRequests(titles.get(m)!)), ...estoqueRequests(estoqueId), ...itensRequests(titles.get(ITENS_TAB)!)] },
  });
  const oldCompras = titles.get("Compras");
  if (oldCompras !== undefined) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId: oldCompras } }] } });
  }
}
