import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";
import {
  FIRST_DATA_ROW,
  cellToNumber,
  readDayTabState,
  rowHasData,
  rowMatchesTransaction,
  validDay,
} from "@/lib/sheets/dayBlockLayout";
import { sheetDestinationKey } from "@/lib/sheets/syncTransaction";

// Só leitura: compara o banco de dados com as abas de mês da planilha e lista
// o que não bate. Não altera nada, nem no banco nem na planilha.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Não autenticado.", { status: 401 });

  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
    include: { sheets: true },
  });
  if (!company?.googleRefreshToken) return new Response("Google Sheets não conectado.", { status: 400 });

  const year = Number(request.nextUrl.searchParams.get("ano")) || new Date().getUTCFullYear();
  const companySheet = company.sheets.find((s) => s.year === year);
  if (!companySheet) return new Response(`Sem planilha de ${year}.`, { status: 404 });

  const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const transactions = await prisma.transaction.findMany({
    where: {
      companyId: session.companyId,
      kind: "PAYABLE",
      dueDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
    },
    include: { supplier: true },
    orderBy: { dueDate: "asc" },
  });
  const monthTxs = transactions.filter((t) =>
    sheetDestinationKey({ kind: t.kind, dueDate: t.dueDate, noteDate: t.noteDate, paid: t.paid }).startsWith("day:")
  );

  const lines: string[] = [];
  const total = { db: 0, found: 0, missing: 0, extra: 0, outOfBlock: 0 };
  const onlyMonth = request.nextUrl.searchParams.get("mes");

  for (let m = 0; m < 12; m++) {
    const tab = MONTHS[m];
    if (onlyMonth && onlyMonth.toLowerCase() !== tab.toLowerCase()) continue;
    const txs = monthTxs.filter((t) => t.dueDate.getUTCMonth() === m);
    if (txs.length === 0 && !onlyMonth) continue;

    const state = await readDayTabState({ sheets, spreadsheetId: companySheet.spreadsheetId, tabName: tab });
    const supplierCol = state.offset + 2;
    const amountCol = state.offset + 6;

    type SheetRow = { row1: number; day: number | null; name: string; amount: number | null; cells: unknown[] };
    const sheetRows: SheetRow[] = [];
    state.body.forEach((cells, i) => {
      if (!rowHasData(cells, supplierCol)) return;
      sheetRows.push({
        row1: FIRST_DATA_ROW + i,
        day: validDay(cells[state.offset]),
        name: String(cells[supplierCol]).trim(),
        amount: cellToNumber(cells[amountCol]),
        cells,
      });
    });

    const used = new Set<number>();
    const missing: string[] = [];
    let found = 0;
    for (const t of txs) {
      const day = t.dueDate.getUTCDate();
      const amount = Number(t.amount);
      const idx = sheetRows.findIndex(
        (r, i) => !used.has(i) && r.day === day && rowMatchesTransaction(r.cells, t.supplier.name, amount)
      );
      if (idx < 0) {
        missing.push(`  dia ${day}: ${t.supplier.name} — R$ ${amount.toFixed(2)}${t.paid ? " (pago)" : ""}`);
      } else {
        used.add(idx);
        found++;
      }
    }
    const extra = sheetRows
      .map((r, i) => ({ r, i }))
      .filter(({ i }) => !used.has(i))
      .map(
        ({ r }) =>
          `  linha ${r.row1} (dia ${r.day ?? "?"}): ${r.name}${r.amount !== null ? ` — R$ ${r.amount.toFixed(2)}` : ""}`
      );
    let outOfBlock = 0;
    for (const r of sheetRows) {
      const b = r.day !== null ? state.located.get(r.day) : undefined;
      if (b && (r.row1 < b.start1 || r.row1 > b.end1)) outOfBlock++;
    }

    total.db += txs.length;
    total.found += found;
    total.missing += missing.length;
    total.extra += extra.length;
    total.outOfBlock += outOfBlock;

    lines.push(
      `== ${tab} == banco: ${txs.length} | achados na planilha: ${found} | faltam na planilha: ${missing.length} | na planilha sem banco: ${extra.length} | fora do bloco do dia: ${outOfBlock}`
    );
    if (missing.length) lines.push("Faltam na planilha (estão no banco):", ...missing.slice(0, 60));
    if (extra.length) lines.push("Estão na planilha mas não no banco:", ...extra.slice(0, 60));
  }

  const notSynced = transactions.filter((t) => t.sheetSyncStatus !== "SYNCED").length;
  lines.unshift(
    `Conferência ${year}: ${total.db} no banco, ${total.found} batem, ${total.missing} faltam na planilha, ${total.extra} na planilha sem banco, ${total.outOfBlock} fora do bloco do dia, ${notSynced} marcados como não sincronizados.`,
    ""
  );
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
