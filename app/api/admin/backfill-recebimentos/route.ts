import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { rebuildRecebimentosTab } from "@/lib/sheets/backfillRecebimentos";
import { fixMonthTabDatesToBR } from "@/lib/sheets/backfillMonthTabDates";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";

// Reconstrói a aba Recebimentos das planilhas já existentes da empresa
// logada (agrupada por mês, com total no final de cada bloco) e corrige
// pro padrão BR qualquer data ainda em ISO nas abas de mês (Contas a
// Pagar) e na própria Recebimentos. Planilhas novas já nascem certas —
// ver provisionCompanySheet.ts.
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: session.companyId },
    include: { sheets: true },
  });

  if (!company.googleRefreshToken) {
    return NextResponse.json({ error: "Google Sheets ainda não conectado." }, { status: 400 });
  }

  const results = [];
  for (const sheet of company.sheets) {
    const { transactionsPlaced } = await rebuildRecebimentosTab({
      companyId: session.companyId,
      spreadsheetId: sheet.spreadsheetId,
      year: sheet.year,
      googleRefreshToken: company.googleRefreshToken,
    });

    let monthDatesFixed = 0;
    for (const month of MONTHS) {
      const { changed } = await fixMonthTabDatesToBR({
        spreadsheetId: sheet.spreadsheetId,
        monthName: month,
        googleRefreshToken: company.googleRefreshToken,
      });
      monthDatesFixed += changed;
    }

    results.push({ year: sheet.year, transactionsPlaced, monthDatesFixed });
  }

  return NextResponse.json({ ok: true, results });
}
