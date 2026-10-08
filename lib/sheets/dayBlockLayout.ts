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

export const FIRST_DATA_ROW = 3;
export const ROWS_PER_DAY = 30;
// Até onde a planilha é lida pra achar os blocos (sobra de linhas inseridas à mão).
export const SCAN_LAST_ROW = 1000;

export type DayBlock = { start1: number; end1: number };

/** Bloco do dia pela conta original (30 linhas por dia, a partir da linha 3). */
export function mathBlockFor(day: number): DayBlock {
  const start1 = FIRST_DATA_ROW + (day - 1) * ROWS_PER_DAY;
  return { start1, end1: start1 + ROWS_PER_DAY - 1 };
}

/** Coluna cujo cabeçalho (linha 2) é exatamente `name`, ignorando acento e caixa. */
export function findHeaderColumn(headerRow: unknown[] | undefined, name: string): number | null {
  const wanted = normalizeText(name);
  const index = (headerRow ?? []).findIndex((cell) => normalizeText(String(cell ?? "")) === wanted);
  return index >= 0 ? index : null;
}

export function validDay(cell: unknown): number | null {
  return typeof cell === "number" && Number.isInteger(cell) && cell >= 1 && cell <= 31 ? cell : null;
}

/**
 * Acha o bloco de cada dia pela PRÓPRIA planilha, não por "30 linhas por dia":
 * o bloco do dia começa na linha que tem a fórmula do "Total do dia" (e o
 * número do dia na coluna Dia) e vai até a linha antes do bloco do dia
 * seguinte. Assim, linhas inseridas ou apagadas à mão entre os dias não
 * desalinham mais o que o app grava. Só confia num dia se o bloco dele e o
 * do dia seguinte foram achados e o tamanho é plausível; os demais ficam de
 * fora (quem usa cai na conta original pra eles).
 */
export function locateDayBlocks(
  body: unknown[][],
  diaCol: number,
  totalCol: number | null
): Map<number, DayBlock> {
  const located = new Map<number, DayBlock>();
  if (totalCol === null) return located;

  const starts = new Map<number, number>();
  body.forEach((row, i) => {
    const formula = row?.[totalCol];
    const day = validDay(row?.[diaCol]);
    if (day !== null && typeof formula === "string" && formula.startsWith("=") && !starts.has(day)) {
      starts.set(day, FIRST_DATA_ROW + i);
    }
  });

  for (let day = 1; day <= 31; day++) {
    const start1 = starts.get(day);
    if (start1 === undefined) continue;
    let end1: number;
    if (day < 31) {
      const next = starts.get(day + 1);
      if (next === undefined) continue;
      end1 = next - 1;
    } else {
      end1 = start1 + ROWS_PER_DAY - 1;
    }
    const length = end1 - start1 + 1;
    if (length < ROWS_PER_DAY - 10 || length > ROWS_PER_DAY + 15) continue;
    located.set(day, { start1, end1 });
  }
  return located;
}

export function blockForDay(day: number, located: Map<number, DayBlock>): DayBlock {
  return located.get(day) ?? mathBlockFor(day);
}

export function rowHasData(row: unknown[] | undefined, supplierCol: number): boolean {
  const cell = row?.[supplierCol];
  return typeof cell === "string" && cell.trim() !== "";
}

/**
 * Dias que precisam ser regravados JUNTOS pra regravar `day` sem perder nada.
 * Linhas gravadas pela conta antiga (30 por dia) podem estar fora do bloco que
 * a planilha tem hoje pro dia: se o bloco do dia cobre linhas com lançamentos
 * de outro dia, esse outro dia entra (senão seus lançamentos seriam apagados),
 * e se o dia tem lançamentos soltos fora do bloco, o dono daquelas linhas
 * entra (pra elas serem limpas). `conflict` vem preenchido se os blocos
 * envolvidos se sobrepõem — nesse caso o certo é não gravar nada.
 */
export function planBlockRewrite(params: {
  body: unknown[][];
  diaCol: number;
  supplierCol: number;
  located: Map<number, DayBlock>;
  day: number;
}): { days: number[]; blocks: Map<number, DayBlock>; conflict: string | null } {
  const { body, diaCol, supplierCol, located } = params;
  const rowAt = (row1: number) => body[row1 - FIRST_DATA_ROW];
  const ownerOfRow = (row1: number): number | null => {
    for (let d = 1; d <= 31; d++) {
      const b = located.get(d);
      if (b && row1 >= b.start1 && row1 <= b.end1) return d;
    }
    for (let d = 1; d <= 31; d++) {
      if (located.has(d)) continue;
      const b = mathBlockFor(d);
      if (row1 >= b.start1 && row1 <= b.end1) return d;
    }
    return null;
  };

  const days = new Set<number>([params.day]);
  const queue = [params.day];
  while (queue.length > 0) {
    const d = queue.pop()!;
    const b = blockForDay(d, located);

    for (let r = b.start1; r <= b.end1; r++) {
      const row = rowAt(r);
      const other = validDay(row?.[diaCol]);
      if (rowHasData(row, supplierCol) && other !== null && other !== d && !days.has(other)) {
        days.add(other);
        queue.push(other);
      }
    }

    body.forEach((row, i) => {
      const r = FIRST_DATA_ROW + i;
      if (r >= b.start1 && r <= b.end1) return;
      if (!rowHasData(row, supplierCol) || validDay(row?.[diaCol]) !== d) return;
      const owner = ownerOfRow(r);
      if (owner !== null && !days.has(owner)) {
        days.add(owner);
        queue.push(owner);
      }
    });
  }

  const sorted = [...days].sort((a, b) => a - b);
  const blocks = new Map(sorted.map((d) => [d, blockForDay(d, located)] as const));
  let conflict: string | null = null;
  const list = sorted.map((d) => ({ d, ...blocks.get(d)! })).sort((a, b) => a.start1 - b.start1);
  for (let i = 1; i < list.length; i++) {
    if (list[i].start1 <= list[i - 1].end1) {
      conflict = `os blocos dos dias ${list[i - 1].d} e ${list[i].d} se sobrepõem (linhas ${list[i].start1}-${list[i - 1].end1})`;
    }
  }
  return { days: sorted, blocks, conflict };
}

/** Lê o cabeçalho e as linhas de dados da aba do mês numa chamada só, e acha os blocos dos dias. */
export async function readDayTabState(params: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  tabName: string;
}): Promise<{
  header: unknown[];
  body: unknown[][];
  offset: number;
  totalCol: number | null;
  located: Map<number, DayBlock>;
}> {
  const res = await params.sheets.spreadsheets.values.get({
    spreadsheetId: params.spreadsheetId,
    range: `'${params.tabName}'!A2:Z${SCAN_LAST_ROW}`,
    // Fórmulas aparecem como texto ("=IF(...") — é assim que se acha o começo
    // de cada bloco; o resto vem como valor bruto (número continua número).
    valueRenderOption: "FORMULA",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  const header = values[0] ?? [];
  const body = values.slice(1);
  const offset = findDayColumnOffset(header);
  const totalCol = findHeaderColumn(header, "total do dia");
  return { header, body, offset, totalCol, located: locateDayBlocks(body, offset, totalCol) };
}

/**
 * Coluna da caixinha EXCLUIR, achada pelo cabeçalho (linha 2, de A até Z) — o
 * usuário escolhe onde ela fica (de preferência longe de PAGO/CONFERIDO, pra
 * não marcar sem querer). Sem cabeçalho "EXCLUIR" devolve null e o app nunca
 * apaga nada por esse caminho.
 */
export function findExcluirColumn(headerRow: unknown[] | undefined): number | null {
  const index = (headerRow ?? []).findIndex((cell) => normalizeText(String(cell ?? "")) === "excluir");
  return index >= 0 ? index : null;
}

export function cellToNumber(cell: unknown): number | null {
  if (typeof cell === "number") return cell;
  if (typeof cell !== "string") return null;
  const cleaned = cell.replace(/R\$|\s/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * A linha é deste lançamento? Confere fornecedor e valor em QUALQUER coluna —
 * assim funciona mesmo em linha gravada uma coluna fora do lugar. Existe pra
 * nunca apagar/compactar a linha errada quando a planilha mudou por fora
 * (linha movida ou apagada na mão) e a posição guardada no banco ficou velha.
 */
export function rowMatchesTransaction(
  row: unknown[] | undefined,
  supplierName: string,
  amount: number
): boolean {
  if (!row) return false;
  const supplierNorm = normalizeText(supplierName);
  const hasSupplier = row.some(
    (cell) => typeof cell === "string" && normalizeText(cell) === supplierNorm
  );
  const hasAmount = row.some((cell) => {
    const n = cellToNumber(cell);
    return n !== null && Math.abs(n - amount) < 0.005;
  });
  return hasSupplier && hasAmount;
}
