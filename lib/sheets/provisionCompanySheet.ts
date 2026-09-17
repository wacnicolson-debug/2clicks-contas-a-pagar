import { sheets_v4 } from "googleapis";
import { getGoogleClientsForCompany } from "./client";

export const MONTHS = [
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
] as const;

const PAYMENT_HEADERS = [
  "Dia",
  "Data de vencimento",
  "Favorecido/fornecedor",
  "Descrição",
  "Forma de pagamento",
  "PIX/dados bancários",
  "Valor",
  "Categoria do custo",
  "Observações",
  "Total do dia",
];

const RECEBIMENTOS_HEADERS = [
  "Data prevista",
  "Data recebida",
  "Cliente/origem",
  "Descrição",
  "Tipo",
  "Forma de recebimento",
  "Conta/destino",
  "Valor previsto",
  "Valor recebido",
  "Observações",
];

// Lista inicial de categorias conhecidas — cresce sozinha conforme o app
// encontra tipos de despesa novos (ver contexto-projeto.md, seção "Classificação de custo").
export const DEFAULT_CATEGORIES = [
  "MATÉRIA-PRIMA - TECIDOS",
  "MATÉRIA-PRIMA - AVIAMENTOS",
  "MÃO DE OBRA",
  "FRETE",
  "FOLHA DE PAGAMENTO",
  "COMBUSTÍVEL",
  "ÁGUA",
  "ENERGIA",
  "IMPOSTOS",
  "DEPÓSITOS JUDICIAIS",
  "SERVIÇOS AMBIENTAIS",
  "MANUTENÇÃO",
  "MECÂNICO",
  "SERVIÇOS",
  "SOFTWARES",
  "ADMINISTRATIVO",
  "FINANCEIRO",
  "DESPESAS FINANCEIRAS - JUROS",
  "DESPESAS FINANCEIRAS - IOF",
  "INVESTIMENTOS",
  "OUTROS",
];

const ROWS_PER_DAY = 30;
const DAYS_IN_BLOCK = 31; // sempre reserva 31 dias, meses menores ficam com linhas sobrando
const HEADER_ROWS = 2; // título + cabeçalho de colunas

export const COST_TAB = "Classificação de Custos";
export const RECEBIMENTOS_TAB = "Recebimentos";

// Histórico (oculto) de lançamentos já PAGOS — não entram no fluxo de "Contas
// a Pagar" (abas de mês), porque essa aba é só pra obrigações ainda em
// aberto. Mas o custo ainda precisa contar na Classificação de Custos, então
// fica registrado aqui e a fórmula de custo soma as duas fontes.
export const PAID_LOG_TAB = "Custos Pagos";
const PAID_LOG_HEADERS = ["Mês", "Categoria", "Valor", "Fornecedor", "Data", "TransactionId"];

type SheetIdMap = Record<string, number>;

/**
 * Cria a planilha de UM ano específico pra uma empresa. Cada ano tem a sua
 * própria planilha — evita uma única planilha crescer pra sempre com dezenas
 * de anos de abas (o que ficaria lento e difícil de navegar depois de um
 * tempo). O app cria a planilha do ano seguinte sozinho quando precisa
 * (ver `getOrCreateCompanySheetForYear`).
 */
export async function provisionCompanySheet(
  companyName: string,
  googleRefreshToken: string,
  year: number
): Promise<{ spreadsheetId: string; sheetIdMap: SheetIdMap }> {
  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);

  const allTabTitles = [...MONTHS, RECEBIMENTOS_TAB, PAID_LOG_TAB, COST_TAB];

  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      // locale fixo: garante que as fórmulas (escritas com ";" entre argumentos,
      // padrão brasileiro) sempre batem com o que a planilha espera, não importa
      // o idioma da conta Google que autorizou.
      properties: { title: `Contas a Pagar — ${companyName} — ${year}`, locale: "pt_BR" },
      sheets: allTabTitles.map((title) => ({ properties: { title } })),
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Falha ao criar a planilha");

  const sheetIdMap: SheetIdMap = {};
  for (const sheet of createRes.data.sheets ?? []) {
    const title = sheet.properties?.title;
    const sheetId = sheet.properties?.sheetId;
    if (title && sheetId !== undefined && sheetId !== null) {
      sheetIdMap[title] = sheetId;
    }
  }

  const valueRanges: sheets_v4.Schema$ValueRange[] = [];
  const structuralRequests: sheets_v4.Schema$Request[] = [];

  for (const month of MONTHS) {
    valueRanges.push(buildMonthValues(month));
    structuralRequests.push(...buildMonthStructuralRequests(sheetIdMap[month]));
  }

  valueRanges.push(buildRecebimentosValues());
  valueRanges.push(buildRecebimentosSummaryValues(year));
  structuralRequests.push(
    ...buildSimpleHeaderStructuralRequests(sheetIdMap[RECEBIMENTOS_TAB]),
    ...buildRecebimentosSummaryStructuralRequests(sheetIdMap[RECEBIMENTOS_TAB])
  );

  valueRanges.push(buildPaidLogValues());
  structuralRequests.push(...buildPaidLogStructuralRequests(sheetIdMap[PAID_LOG_TAB]));

  valueRanges.push(buildCostSummaryValues(DEFAULT_CATEGORIES));
  structuralRequests.push(
    ...buildCostSummaryStructuralRequests(sheetIdMap[COST_TAB], DEFAULT_CATEGORIES)
  );

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: valueRanges,
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: structuralRequests },
  });

  // Criada via OAuth da própria empresa: a planilha já nasce no Drive dela,
  // sem precisar de nenhum passo extra de compartilhamento.
  return { spreadsheetId, sheetIdMap };
}

// ---------- Abas de mês (fluxo de pagamentos, agrupado por dia) ----------

export function buildMonthValues(month: string): sheets_v4.Schema$ValueRange {
  const rows: (string | number)[][] = [];

  rows.push([`CONTROLE DE PAGAMENTOS — ${month.toUpperCase()}`]);
  rows.push(PAYMENT_HEADERS);

  for (let day = 1; day <= DAYS_IN_BLOCK; day++) {
    const blockStart1 = HEADER_ROWS + (day - 1) * ROWS_PER_DAY + 1;
    const blockEnd1 = blockStart1 + ROWS_PER_DAY - 1;

    for (let i = 0; i < ROWS_PER_DAY; i++) {
      const row1 = blockStart1 + i;
      // A soma do dia sempre aparece na 1ª linha do bloco — é a única que
      // fica visível quando o dia está recolhido, então é ali que precisa
      // bater o olho e ver o total, não numa linha escondida no meio.
      const totalDoDia =
        row1 === blockStart1
          ? `=IF(COUNTA(G${blockStart1}:G${blockEnd1})=0;"";SUM(G${blockStart1}:G${blockEnd1}))`
          : "";

      // Dia | Vencimento | Favorecido | Descrição | Forma pgto | PIX | Valor | Categoria | Obs | Total do dia
      rows.push([day, "", "", "", "", "", "", "", "", totalDoDia]);
    }
  }

  const totalRow1Based = HEADER_ROWS + DAYS_IN_BLOCK * ROWS_PER_DAY + 1;
  const firstDataRow1Based = HEADER_ROWS + 1;
  const lastDataRow1Based = totalRow1Based - 1;
  rows.push([
    "TOTAL DO MÊS",
    "",
    "",
    "",
    "",
    "",
    `=SUM(G${firstDataRow1Based}:G${lastDataRow1Based})`,
    "",
    "",
    "",
  ]);

  return {
    range: `'${month}'!A1`,
    values: rows,
  };
}

function buildMonthStructuralRequests(
  sheetId: number
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];

  requests.push(...commonHeaderFormatting(sheetId, PAYMENT_HEADERS.length));

  // Formato de moeda nas colunas Valor (G, índice 6) e Total do dia (J, índice 9)
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: HEADER_ROWS,
        startColumnIndex: 6,
        endColumnIndex: 7,
      },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: HEADER_ROWS,
        startColumnIndex: 9,
        endColumnIndex: 10,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' },
          textFormat: { bold: true },
        },
      },
      fields: "userEnteredFormat.numberFormat,userEnteredFormat.textFormat",
    },
  });

  // Agrupa cada dia: a 1ª linha do bloco fica sempre visível (resumo),
  // as outras 29 ficam agrupadas e recolhidas por padrão.
  for (let day = 0; day < DAYS_IN_BLOCK; day++) {
    const blockStart0 = HEADER_ROWS + day * ROWS_PER_DAY; // 0-based, linha-resumo do dia
    const detailStart0 = blockStart0 + 1;
    const detailEnd0 = blockStart0 + ROWS_PER_DAY; // exclusivo

    const range: sheets_v4.Schema$DimensionRange = {
      sheetId,
      dimension: "ROWS",
      startIndex: detailStart0,
      endIndex: detailEnd0,
    };

    requests.push({ addDimensionGroup: { range } });
    requests.push({
      updateDimensionGroup: {
        dimensionGroup: { range, depth: 1, collapsed: true },
        fields: "collapsed",
      },
    });
    requests.push({
      updateDimensionProperties: {
        range,
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    });
  }

  return requests;
}

// ---------- Aba Recebimentos ----------

function buildRecebimentosValues(): sheets_v4.Schema$ValueRange {
  return {
    range: `'${RECEBIMENTOS_TAB}'!A1`,
    values: [["CONTROLE DE RECEBIMENTOS"], RECEBIMENTOS_HEADERS],
  };
}

function buildSimpleHeaderStructuralRequests(
  sheetId: number
): sheets_v4.Schema$Request[] {
  return commonHeaderFormatting(sheetId, RECEBIMENTOS_HEADERS.length);
}

// Bloco de resumo mensal (soma do que foi vendido em cada mês), ao lado da
// lista de recebimentos, nas colunas L/M — SUMIFS sobre a data prevista
// (coluna A) e o valor previsto (coluna H) da própria lista.
const SUMMARY_MONTH_COLUMN = "L";
const SUMMARY_VALUE_COLUMN = "M";

export function buildRecebimentosSummaryValues(year: number): sheets_v4.Schema$ValueRange {
  const rows: (string | number)[][] = [];
  rows.push([`RESUMO MENSAL DE VENDAS — ${year}`]);
  rows.push(["Mês", "Total vendido"]);

  MONTHS.forEach((month, index) => {
    const monthNumber = index + 1;
    const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
    const nextYear = monthNumber === 12 ? year + 1 : year;
    const formula =
      `=SUMIFS('${RECEBIMENTOS_TAB}'!$H$3:$H$100000;` +
      `'${RECEBIMENTOS_TAB}'!$A$3:$A$100000;">="&DATE(${year};${monthNumber};1);` +
      `'${RECEBIMENTOS_TAB}'!$A$3:$A$100000;"<"&DATE(${nextYear};${nextMonthNumber};1))`;
    rows.push([month, formula]);
  });

  rows.push([
    "TOTAL DO ANO",
    `=SUM(${SUMMARY_VALUE_COLUMN}3:${SUMMARY_VALUE_COLUMN}14)`,
  ]);

  return {
    range: `'${RECEBIMENTOS_TAB}'!${SUMMARY_MONTH_COLUMN}1`,
    values: rows,
  };
}

export function buildRecebimentosSummaryStructuralRequests(
  sheetId: number
): sheets_v4.Schema$Request[] {
  const startColumnIndex = 11; // L
  const endColumnIndex = 13; // M, exclusivo

  return [
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex, endColumnIndex },
        mergeType: "MERGE_ALL",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex, endColumnIndex },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 12 },
            backgroundColor: { red: 0.16, green: 0.28, blue: 0.24 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex, endColumnIndex },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 14, startColumnIndex: 12, endColumnIndex },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 14, endRowIndex: 15, startColumnIndex, endColumnIndex },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' },
          },
        },
        fields: "userEnteredFormat(textFormat,numberFormat)",
      },
    },
  ];
}

// ---------- Aba Custos Pagos (histórico oculto, insumo da Classificação de Custos) ----------

function buildPaidLogValues(): sheets_v4.Schema$ValueRange {
  return {
    range: `'${PAID_LOG_TAB}'!A1`,
    values: [["HISTÓRICO DE CUSTOS JÁ PAGOS (NÃO ENTRA NO FLUXO DE CONTAS A PAGAR)"], PAID_LOG_HEADERS],
  };
}

function buildPaidLogStructuralRequests(sheetId: number): sheets_v4.Schema$Request[] {
  return [
    ...commonHeaderFormatting(sheetId, PAID_LOG_HEADERS.length),
    // Aba de apoio pra fórmula, não pra navegação manual — fica oculta.
    {
      updateSheetProperties: {
        properties: { sheetId, hidden: true },
        fields: "hidden",
      },
    },
  ];
}

// ---------- Aba Classificação de Custos (compilada, por mês) ----------

export function buildCostSummaryValues(categories: string[]): sheets_v4.Schema$ValueRange {
  const rows: (string | number)[][] = [];
  rows.push(["DISTRIBUIÇÃO DE CUSTOS POR CATEGORIA"]);
  rows.push(["Categoria de custo", "Valor total"]);

  for (const month of MONTHS) {
    rows.push([month.toUpperCase(), ""]);
    const catStart1 = rows.length + 1;
    for (const category of categories) {
      // Soma duas fontes: a aba do mês (obrigações ainda em aberto, "a pagar")
      // e o histórico oculto de já pagos (que nunca chega a virar linha na
      // aba de Contas a Pagar) — o custo total do mês é a soma das duas.
      const row = rows.length + 1;
      const formula =
        `=SUMIFS('${month}'!$G:$G;'${month}'!$H:$H;A${row})` +
        `+SUMIFS('${PAID_LOG_TAB}'!$C:$C;'${PAID_LOG_TAB}'!$A:$A;"${month}";'${PAID_LOG_TAB}'!$B:$B;A${row})`;
      rows.push([category, formula]);
    }
    const catEnd1 = rows.length;
    rows.push(["Total do mês", `=SUM(B${catStart1}:B${catEnd1})`]);
  }

  return { range: `'${COST_TAB}'!A1`, values: rows };
}

export function buildCostSummaryStructuralRequests(
  sheetId: number,
  categories: string[]
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  requests.push(...commonHeaderFormatting(sheetId, 2));

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: HEADER_ROWS, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });

  const blockSize = 1 + categories.length + 1; // cabeçalho do mês + categorias + total
  for (let m = 0; m < MONTHS.length; m++) {
    const blockStart0 = HEADER_ROWS + m * blockSize; // linha do nome do mês (resumo)
    const groupStart0 = blockStart0 + 1; // primeira categoria
    const groupEnd0 = blockStart0 + blockSize; // exclusivo — inclui categorias + total do mês

    const range: sheets_v4.Schema$DimensionRange = {
      sheetId,
      dimension: "ROWS",
      startIndex: groupStart0,
      endIndex: groupEnd0,
    };

    requests.push({ addDimensionGroup: { range } });
    requests.push({
      updateDimensionGroup: {
        dimensionGroup: { range, depth: 1, collapsed: true },
        fields: "collapsed",
      },
    });
    requests.push({
      updateDimensionProperties: {
        range,
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    });
  }

  return requests;
}

// ---------- Formatação comum (título mesclado + cabeçalho em negrito) ----------

function commonHeaderFormatting(
  sheetId: number,
  columnCount: number
): sheets_v4.Schema$Request[] {
  return [
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        mergeType: "MERGE_ALL",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 12 },
            backgroundColor: { red: 0.16, green: 0.28, blue: 0.24 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 2 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
  ];
}
