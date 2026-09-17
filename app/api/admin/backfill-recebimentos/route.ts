import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { backfillRecebimentosForCompanySheet } from "@/lib/sheets/backfillRecebimentos";

// Corrige as planilhas já existentes da empresa logada (datas da aba
// Recebimentos em padrão ISO -> BR, e adiciona o resumo mensal de vendas).
// Planilhas novas já nascem certas — ver provisionCompanySheet.ts.
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
    const { datesFixed } = await backfillRecebimentosForCompanySheet({
      spreadsheetId: sheet.spreadsheetId,
      year: sheet.year,
      googleRefreshToken: company.googleRefreshToken,
    });
    results.push({ year: sheet.year, datesFixed });
  }

  return NextResponse.json({ ok: true, results });
}
