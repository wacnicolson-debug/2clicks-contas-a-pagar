import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import {
  FIRST_DATA_ROW,
  columnLetter,
  readDayTabState,
  rowMatchesTransaction,
  validDay,
} from "@/lib/sheets/dayBlockLayout";

// TEMPORÁRIO (uso único): preenche a célula do dia em 3 linhas que ficaram com
// o dia em branco. Só escreve se a linha ainda tiver fornecedor + valor
// esperados e o dia estiver vazio. Será removido logo depois de rodar.
const FIXES = [
  { tab: "Setembro", row1: 537, day: 18, supplier: "MRC CONFECCOES LTDA", amount: 19192.93 },
  { tab: "Setembro", row1: 617, day: 21, supplier: "L2G INDUSTRIAL LTDA", amount: 5180.5 },
  { tab: "Outubro", row1: 5, day: 1, supplier: "TEAR TEXTIL INDUSTRIA E COMERCIO LTDA", amount: 4364.25 },
];

export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Não autenticado.", { status: 401 });
  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
    include: { sheets: true },
  });
  const sheet = company?.sheets.find((s) => s.year === 2026);
  if (!company?.googleRefreshToken || !sheet) return new Response("Sem planilha 2026.", { status: 404 });
  const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);

  const out: string[] = [];
  const stateByTab = new Map<string, Awaited<ReturnType<typeof readDayTabState>>>();
  const writes: { range: string; day: number }[] = [];
  for (const f of FIXES) {
    if (!stateByTab.has(f.tab)) {
      stateByTab.set(f.tab, await readDayTabState({ sheets, spreadsheetId: sheet.spreadsheetId, tabName: f.tab }));
    }
    const st = stateByTab.get(f.tab)!;
    const row = st.body[f.row1 - FIRST_DATA_ROW];
    if (!rowMatchesTransaction(row, f.supplier, f.amount)) {
      out.push(`${f.tab} linha ${f.row1}: não é mais ${f.supplier} R$ ${f.amount} — NÃO mexi.`);
      continue;
    }
    if (validDay(row?.[st.offset]) !== null) {
      out.push(`${f.tab} linha ${f.row1}: já tem dia (${String(row?.[st.offset])}) — NÃO mexi.`);
      continue;
    }
    writes.push({ range: `'${f.tab}'!${columnLetter(st.offset)}${f.row1}`, day: f.day });
    out.push(`${f.tab} linha ${f.row1}: dia ${f.day} preenchido (${f.supplier}).`);
  }
  if (writes.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheet.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: writes.map((w) => ({ range: w.range, values: [[w.day]] })),
      },
    });
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
