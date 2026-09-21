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

// Linhas reservadas por mês na aba Recebimentos — folga generosa (bem mais
// que o volume normal de vendas/mês), mesma ideia do ROWS_PER_DAY acima.
export const RECEBIMENTOS_ROWS_PER_MONTH = 80;

export const COST_TAB = "Classificação de Custos";
export const BUDGET_TAB = "Orçamento";
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

  const allTabTitles = [...MONTHS, RECEBIMENTOS_TAB, PAID_LOG_TAB, COST_TAB, BUDGET_TAB];

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

  valueRanges.push(buildRecebimentosValues(year));
  structuralRequests.push(...buildRecebimentosStructuralRequests(sheetIdMap[RECEBIMENTOS_TAB]));

  valueRanges.push(buildPaidLogValues());
  structuralRequests.push(...buildPaidLogStructuralRequests(sheetIdMap[PAID_LOG_TAB]));

  valueRanges.push(buildCostSummaryValues(DEFAULT_CATEGORIES));
  structuralRequests.push(
    ...buildCostSummaryStructuralRequests(sheetIdMap[COST_TAB], DEFAULT_CATEGORIES)
  );

  const defaultBudgetCategories = DEFAULT_CATEGORIES.map((name) => ({
    name,
    budgetSmoothed: false,
  }));
  valueRanges.push(buildBudgetValues(defaultBudgetCategories));
  structuralRequests.push(
    ...buildBudgetStructuralRequests(sheetIdMap[BUDGET_TAB], defaultBudgetCategories)
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

// ---------- Aba Recebimentos (agrupada por mês, com total no final de cada bloco) ----------

// Linha (0-based) onde cada bloco de mês começa/termina, pra ficar igual em
// todo lugar que precisa escrever ou formatar essa aba (aqui, na gravação de
// cada recebimento e no rebuild de planilha antiga).
export function recebimentosMonthBlockRows(monthIndex0: number): {
  labelRow0: number;
  dataStart0: number;
  dataEnd0: number; // exclusivo
  totalRow0: number;
} {
  const blockSize = 1 + RECEBIMENTOS_ROWS_PER_MONTH + 1; // rótulo do mês + dados + total
  const labelRow0 = HEADER_ROWS + monthIndex0 * blockSize;
  const dataStart0 = labelRow0 + 1;
  const dataEnd0 = dataStart0 + RECEBIMENTOS_ROWS_PER_MONTH;
  return { labelRow0, dataStart0, dataEnd0, totalRow0: dataEnd0 };
}

export function buildRecebimentosValues(year: number): sheets_v4.Schema$ValueRange {
  const rows: (string | number)[][] = [];
  rows.push([`CONTROLE DE RECEBIMENTOS — ${year}`]);
  rows.push(RECEBIMENTOS_HEADERS);

  for (const month of MONTHS) {
    rows.push([month.toUpperCase()]);
    for (let i = 0; i < RECEBIMENTOS_ROWS_PER_MONTH; i++) {
      rows.push(["", "", "", "", "", "", "", "", "", ""]);
    }
    const dataEnd1 = rows.length;
    const dataStart1 = dataEnd1 - RECEBIMENTOS_ROWS_PER_MONTH + 1;
    rows.push([
      "TOTAL DO MÊS",
      "",
      "",
      "",
      "",
      "",
      "",
      `=IF(COUNTA(H${dataStart1}:H${dataEnd1})=0;"";SUM(H${dataStart1}:H${dataEnd1}))`,
      `=IF(COUNTA(I${dataStart1}:I${dataEnd1})=0;"";SUM(I${dataStart1}:I${dataEnd1}))`,
      "",
    ]);
  }

  return {
    range: `'${RECEBIMENTOS_TAB}'!A1`,
    values: rows,
  };
}

export function buildRecebimentosStructuralRequests(
  sheetId: number
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  requests.push(...commonHeaderFormatting(sheetId, RECEBIMENTOS_HEADERS.length));

  // Formato de moeda nas colunas Valor previsto (H, índice 7) e Valor recebido (I, índice 8)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: HEADER_ROWS, startColumnIndex: 7, endColumnIndex: 9 },
      cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });

  MONTHS.forEach((_month, monthIndex0) => {
    const { labelRow0, dataStart0, dataEnd0, totalRow0 } = recebimentosMonthBlockRows(monthIndex0);

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: labelRow0,
          endRowIndex: labelRow0 + 1,
          startColumnIndex: 0,
          endColumnIndex: RECEBIMENTOS_HEADERS.length,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.95, blue: 0.94 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    });

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: totalRow0,
          endRowIndex: totalRow0 + 1,
          startColumnIndex: 0,
          endColumnIndex: RECEBIMENTOS_HEADERS.length,
        },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    });

    // Linhas de dados do mês ficam agrupadas e recolhidas por padrão — só o
    // rótulo do mês e o total ficam sempre visíveis.
    const range: sheets_v4.Schema$DimensionRange = {
      sheetId,
      dimension: "ROWS",
      startIndex: dataStart0,
      endIndex: dataEnd0,
    };
    requests.push({ addDimensionGroup: { range } });
    requests.push({
      updateDimensionGroup: { dimensionGroup: { range, depth: 1, collapsed: true }, fields: "collapsed" },
    });
    requests.push({
      updateDimensionProperties: { range, properties: { hiddenByUser: true }, fields: "hiddenByUser" },
    });
  });

  return requests;
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

// Linha (1-based) de uma categoria dentro do bloco de um mês na Classificação
// de Custos — mesma matemática de `buildCostSummaryValues`, extraída pra ser
// reutilizada pelas referências de célula da aba de Orçamento (que aponta
// pra essas mesmas linhas em vez de duplicar a fórmula de soma).
function costSummaryCategoryRow1(
  monthIndex0: number,
  categoryIndex0: number,
  categoryCount: number
): number {
  const blockSize = categoryCount + 2; // rótulo do mês + categorias + total
  const headerRow1 = 3 + monthIndex0 * blockSize;
  return headerRow1 + 1 + categoryIndex0;
}

// ---------- Aba Orçamento (clona a Classificação de Custos por referência) ----------

export type BudgetCategory = { name: string; budgetSmoothed: boolean };

export function buildBudgetValues(categories: BudgetCategory[]): sheets_v4.Schema$ValueRange {
  const rows: (string | number)[][] = [];
  rows.push(["ORÇAMENTO POR CATEGORIA"]);
  rows.push(["Categoria de custo", "Valor orçado"]);

  MONTHS.forEach((month, monthIndex0) => {
    rows.push([month.toUpperCase(), ""]);
    const catStart1 = rows.length + 1;
    categories.forEach((category, categoryIndex0) => {
      const thisMonthCell = `'${COST_TAB}'!B${costSummaryCategoryRow1(monthIndex0, categoryIndex0, categories.length)}`;
      const formula = category.budgetSmoothed
        ? `=AVERAGE(${Array.from(
            { length: monthIndex0 + 1 },
            (_, m) => `'${COST_TAB}'!B${costSummaryCategoryRow1(m, categoryIndex0, categories.length)}`
          ).join(";")})`
        : `=${thisMonthCell}`;
      rows.push([category.name, formula]);
    });
    const catEnd1 = rows.length;
    rows.push(["Total do mês", `=SUM(B${catStart1}:B${catEnd1})`]);
  });

  return { range: `'${BUDGET_TAB}'!A1`, values: rows };
}

export function buildBudgetStructuralRequests(
  sheetId: number,
  categories: BudgetCategory[]
): sheets_v4.Schema$Request[] {
  // Mesmo layout (título + cabeçalho + blocos de mês colapsáveis) da
  // Classificação de Custos — só os nomes das categorias importam aqui, a
  // fórmula em si não afeta a formatação/agrupamento.
  return buildCostSummaryStructuralRequests(
    sheetId,
    categories.map((c) => c.name)
  );
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
