import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import { MONTHS } from "./provisionCompanySheet";
import {
  EXCLUIR_COLUMN_INDEX,
  cellToNumber,
  columnLetter,
  findDayColumnOffset,
  isExcluirHeader,
  rowMatchesTransaction,
} from "./dayBlockLayout";
import { rebuildDayBlock } from "./syncTransaction";
import { deleteTransactionEverywhere } from "@/lib/transactions/deleteTransaction";

const ROWS_PER_DAY = 30;
const HEADER_ROWS = 2;
const DAYS_IN_BLOCK = 31;
const LAST_BLOCK_ROW1 = HEADER_ROWS + DAYS_IN_BLOCK * ROWS_PER_DAY;

// Um processamento por empresa por vez nesta instância (duas abas abertas
// consultando juntas não disparam a mesma exclusão duas vezes).
const running = new Set<string>();

/** Dia do mês dono da linha (1-based) nos blocos de 30 linhas, ou null se está fora dos blocos. */
export function dayOfSheetRow(row1: number): number | null {
  if (row1 <= HEADER_ROWS || row1 > LAST_BLOCK_ROW1) return null;
  return Math.floor((row1 - HEADER_ROWS - 1) / ROWS_PER_DAY) + 1;
}

/**
 * Procura, nas abas de mês da planilha, linhas com a caixinha EXCLUIR marcada
 * e apaga o lançamento correspondente (planilha + banco), como o botão
 * Excluir do app. A planilha não avisa o app de nada — por isso é o app que
 * confere de tempos em tempos (ver AutoRefresh).
 *
 * Segurança: só vale em aba cujo cabeçalho (linha 2, coluna N) é "EXCLUIR", e
 * o lançamento é achado pelo CONTEÚDO da linha (fornecedor + valor + dia),
 * nunca só pela posição — se a planilha estiver desalinhada com o banco, não
 * acha nada e não apaga nada.
 */
export async function processSheetDeletions(
  companyId: string
): Promise<{ deleted: number; unmatched: number }> {
  if (running.has(companyId)) return { deleted: 0, unmatched: 0 };
  running.add(companyId);
  try {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { sheets: true },
    });
    if (!company?.googleRefreshToken || company.sheets.length === 0) {
      return { deleted: 0, unmatched: 0 };
    }

    const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
    const col = columnLetter(EXCLUIR_COLUMN_INDEX);
    let deleted = 0;
    let unmatched = 0;

    for (const companySheet of company.sheets) {
      const spreadsheetId = companySheet.spreadsheetId;

      // Cabeçalho (linha 2) + todas as caixinhas da coluna, 1 chamada pras 12 abas.
      let flagRanges;
      try {
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: MONTHS.map((m) => `'${m}'!${col}${HEADER_ROWS}:${col}${LAST_BLOCK_ROW1}`),
          majorDimension: "COLUMNS",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        flagRanges = res.data.valueRanges ?? [];
      } catch (err) {
        console.error(`Falha ao ler a coluna EXCLUIR (planilha ${companySheet.year}):`, err);
        continue;
      }

      const flagged: { tab: string; row1: number }[] = [];
      MONTHS.forEach((tab, i) => {
        const column = (flagRanges[i]?.values?.[0] ?? []) as unknown[];
        const headerRow: unknown[] = [];
        headerRow[EXCLUIR_COLUMN_INDEX] = column[0];
        if (!isExcluirHeader(headerRow)) return;
        for (let j = 1; j < column.length; j++) {
          if (column[j] === true) flagged.push({ tab, row1: HEADER_ROWS + j });
        }
      });
      if (flagged.length === 0) continue;

      // Conteúdo das linhas marcadas (+ cabeçalho de cada aba, pra achar a coluna "Dia").
      const tabs = [...new Set(flagged.map((f) => f.tab))];
      const ranges = [
        ...tabs.map((tab) => `'${tab}'!A${HEADER_ROWS}:Z${HEADER_ROWS}`),
        ...flagged.map((f) => `'${f.tab}'!A${f.row1}:Z${f.row1}`),
      ];
      const contentRes = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const contentRanges = contentRes.data.valueRanges ?? [];
      const headerByTab = new Map<string, unknown[]>();
      tabs.forEach((tab, i) => headerByTab.set(tab, (contentRanges[i]?.values?.[0] ?? []) as unknown[]));

      for (const [i, f] of flagged.entries()) {
        const row = (contentRanges[tabs.length + i]?.values?.[0] ?? []) as unknown[];
        const offset = findDayColumnOffset(headerByTab.get(f.tab));
        const supplierName = String(row[offset + 2] ?? "").trim();
        const amount = cellToNumber(row[offset + 6]);
        const day = dayOfSheetRow(f.row1);
        if (!supplierName || amount === null) continue; // linha vazia marcada: nada a apagar
        if (day === null) {
          unmatched++;
          continue;
        }

        const monthIndex0 = MONTHS.indexOf(f.tab as (typeof MONTHS)[number]);
        const candidates = await prisma.transaction.findMany({
          where: {
            companyId,
            kind: "PAYABLE",
            dueDate: {
              gte: new Date(Date.UTC(companySheet.year, monthIndex0, day)),
              lt: new Date(Date.UTC(companySheet.year, monthIndex0, day + 1)),
            },
          },
          include: { supplier: true },
        });
        const matches = candidates.filter((t) =>
          rowMatchesTransaction([supplierName, amount], t.supplier.name, Number(t.amount))
        );
        const target =
          matches.find((t) => t.sheetCellRef === `${f.tab}!A${f.row1}`) ?? matches[0];
        if (!target) {
          unmatched++;
          continue;
        }

        try {
          const result = await deleteTransactionEverywhere(target.id);
          if (!result.deleted) continue;
          // Garante que a planilha reflete o banco mesmo se o lançamento não
          // tinha posição guardada (nesse caso a limpeza não reconstruiu o bloco).
          if (!result.cleared) await rebuildDayBlock(companyId, companySheet.year, f.tab, day);
          deleted++;
        } catch (err) {
          console.error(`Falha ao excluir ${supplierName} marcado na planilha:`, err);
        }
      }
    }

    return { deleted, unmatched };
  } finally {
    running.delete(companyId);
  }
}
