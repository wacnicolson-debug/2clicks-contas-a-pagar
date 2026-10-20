import type { sheets_v4 } from "googleapis";
import { MONTHS } from "./provisionCompanySheet";

// Espaço pra pagamentos atrasados/não pagos no FIM de cada aba de mês, logo depois do
// "TOTAL DO MÊS". É uma área de preenchimento MANUAL (o app não lê nem grava nela): o
// usuário passa pra cá o que estava pra pagar num dia e não foi pago, e edita à mão.
// Fica abaixo do total do mês, então não entra em "Total do dia" nem em "TOTAL DO MÊS".
export const OVERDUE_TITLE = "PAGAMENTOS ATRASADOS / NÃO PAGOS — preencher à mão";
const DATA_ROWS = 50;

const HEADERS: Record<number, string> = {
  2: "Data de vencimento original",
  3: "Favorecido/fornecedor",
  4: "Descrição",
  5: "Forma de pagamento",
  6: "PIX/dados bancários",
  7: "Valor",
  8: "Categoria do custo",
  9: "Observações",
};

/** Cria (se ainda não existir) o espaço de atrasados no fim de cada aba de mês da planilha. */
export async function addOverdueSections(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<{ tab: string; totalRow: number; created: boolean }[]> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title,gridProperties))" });
  const byTitle = new Map(meta.data.sheets!.map((s) => [s.properties!.title!, s.properties!]));
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: MONTHS.map((m) => `'${m}'!A1:D1400`),
  });

  const out: { tab: string; totalRow: number; created: boolean }[] = [];
  const valueData: { range: string; values: (string | number)[][] }[] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  MONTHS.forEach((tab, i) => {
    const props = byTitle.get(tab);
    const rows = res.data.valueRanges?.[i]?.values ?? [];
    if (!props?.sheetId && props?.sheetId !== 0) return;
    const sheetId = props.sheetId as number;

    let totalRow = 0;
    let already = false;
    rows.forEach((r, idx) => {
      const text = r.map((c) => String(c ?? "")).join(" ");
      if (!totalRow && /total do m[eê]s/i.test(text)) totalRow = idx + 1;
      if (/pagamentos atrasados/i.test(text)) already = true;
    });
    // Abas mais antigas (ex: Janeiro) não têm "TOTAL DO MÊS": o fim é a última linha com conteúdo.
    if (!totalRow && !already) {
      rows.forEach((r, idx) => {
        if (r.some((c) => String(c ?? "").trim() !== "")) totalRow = idx + 1;
      });
    }
    if (!totalRow) return;
    if (already) {
      out.push({ tab, totalRow, created: false });
      return;
    }

    const titleRow = totalRow + 2;
    const headerRow = totalRow + 3;
    const firstData = totalRow + 4;
    const lastData = totalRow + 3 + DATA_ROWS;
    const sumRow = lastData + 1;

    // sem linhas suficientes no fim da aba: acrescenta (só no final, não mexe em nada acima)
    const rowCount = props.gridProperties?.rowCount ?? 1000;
    if (rowCount < sumRow + 1) {
      requests.push({ appendDimension: { sheetId, dimension: "ROWS", length: sumRow + 1 - rowCount } });
    }

    valueData.push(
      { range: `'${tab}'!A${titleRow}`, values: [[OVERDUE_TITLE]] },
      { range: `'${tab}'!A${headerRow}:J${headerRow}`, values: [Array.from({ length: 10 }, (_, c) => HEADERS[c] ?? "")] },
      { range: `'${tab}'!D${sumRow}`, values: [["TOTAL ATRASADOS"]] },
      { range: `'${tab}'!H${sumRow}`, values: [[`=SUM(H${firstData}:H${lastData})`]] }
    );

    const cols = (x: number, y: number) => ({ startColumnIndex: x, endColumnIndex: y });
    requests.push(
      // título: faixa escura, texto branco em negrito transbordando pela faixa
      {
        repeatCell: {
          range: { sheetId, startRowIndex: titleRow - 1, endRowIndex: titleRow, ...cols(0, 14) },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.16, green: 0.28, blue: 0.24 }, wrapStrategy: "OVERFLOW_CELL", verticalAlignment: "MIDDLE", textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
          fields: "userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment,textFormat)",
        },
      },
      // cabeçalho: cinza só nas colunas A–J
      {
        repeatCell: {
          range: { sheetId, startRowIndex: headerRow - 1, endRowIndex: headerRow, ...cols(0, 10) },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", textFormat: { bold: true } } },
          fields: "userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment,textFormat)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: firstData - 1, endRowIndex: lastData, startColumnIndex: 2, endColumnIndex: 3 },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: firstData - 1, endRowIndex: sumRow, startColumnIndex: 7, endColumnIndex: 8 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"R$" #,##0.00' } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: sumRow - 1, endRowIndex: sumRow, startColumnIndex: 3, endColumnIndex: 8 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      }
    );
    out.push({ tab, totalRow, created: true });
  });

  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  if (valueData.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: valueData },
    });
  }
  return out;
}
