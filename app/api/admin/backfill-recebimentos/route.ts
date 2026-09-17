import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { rebuildRecebimentosTab } from "@/lib/sheets/backfillRecebimentos";

// Reconstrói a aba Recebimentos das planilhas já existentes da empresa
// logada (agrupada por mês, com total no final de cada bloco, e datas em
// padrão BR). Planilhas novas já nascem certas — ver provisionCompanySheet.ts.
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
    results.push({ year: sheet.year, transactionsPlaced });
  }

  return NextResponse.json({ ok: true, results });
}
