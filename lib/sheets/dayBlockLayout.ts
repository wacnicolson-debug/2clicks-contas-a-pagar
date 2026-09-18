import type { sheets_v4 } from "googleapis";
import { normalizeText } from "@/lib/utils/normalizeText";

// Colunas que o app grava em cada linha do bloco do dia: Dia, Data de
// vencimento, Favorecido, Descrição, Forma de pagamento, PIX, Valor,
// Categoria, Observações. "Total do dia" é fórmula, nunca gravada por aqui.
export const APP_COLUMN_COUNT = 9;

export function columnLetter(index0: number): string {
  let n = index0 + 1;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * A planilha nasce com "Dia" na coluna A, mas o usuário pode inserir colunas
 * antes dela (ex: "Semana") — acha a coluna "Dia" pelo cabeçalho pra o app
 * continuar gravando cada campo na coluna certa. Sem achar, assume A.
 */
export function findDayColumnOffset(headerRow: unknown[] | undefined): number {
  const index = (headerRow ?? []).findIndex((cell) => normalizeText(String(cell ?? "")) === "dia");
  return index >= 0 ? index : 0;
}

/** Lê o cabeçalho e o bloco do dia numa chamada só (uma leitura a menos por lançamento). */
export async function readDayBlockLayout(params: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  tabName: string;
  blockStart1: number;
  blockEnd1: number;
}): Promise<{ offset: number; rows: unknown[][] }> {
  const res = await params.sheets.spreadsheets.values.batchGet({
    spreadsheetId: params.spreadsheetId,
    ranges: [
      `'${params.tabName}'!A2:Z2`,
      `'${params.tabName}'!A${params.blockStart1}:Z${params.blockEnd1}`,
    ],
    // Valor bruto (número continua número) e data já como texto no formato da
    // planilha — regravar isso não converte valor em texto nem data em número.
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const [header, block] = res.data.valueRanges ?? [];
  return {
    offset: findDayColumnOffset(header?.values?.[0]),
    rows: (block?.values ?? []) as unknown[][],
  };
}

/** Linha já tem algo além do "Dia" pré-preenchido (ex: lançamento digitado direto na planilha). */
export function isRowOccupied(row: unknown[] | undefined, offset: number): boolean {
  for (let c = offset + 1; c < offset + APP_COLUMN_COUNT; c++) {
    const value = row?.[c];
    if (value !== undefined && value !== null && String(value).trim() !== "") return true;
  }
  return false;
}
