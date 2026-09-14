import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { exchangeCodeForRefreshToken } from "@/lib/sheets/client";
import { getOrCreateCompanySheetForYear } from "@/lib/sheets/getOrCreateCompanySheet";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.APP_BASE_URL ?? request.nextUrl.origin;
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/dashboard?google_error=${encodeURIComponent(error ?? "sem_code")}`, baseUrl)
    );
  }

  try {
    const refreshToken = await exchangeCodeForRefreshToken(code);

    await prisma.company.update({
      where: { id: session.companyId },
      data: { googleRefreshToken: refreshToken },
    });

    // Provisiona (ou reaproveita) a planilha do ano corrente pra essa empresa.
    await getOrCreateCompanySheetForYear(session.companyId, new Date().getUTCFullYear());

    return NextResponse.redirect(new URL("/dashboard?google_connected=1", baseUrl));
  } catch (err) {
    console.error("Erro ao conectar Google:", err);
    const message = err instanceof Error ? err.message : "erro_desconhecido";
    return NextResponse.redirect(
      new URL(`/dashboard?google_error=${encodeURIComponent(message)}`, baseUrl)
    );
  }
}
