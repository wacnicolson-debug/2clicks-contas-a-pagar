import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { resyncTransactionToSheet } from "@/lib/sheets/syncTransaction";

// "Reenviar pra planilha": só grava o lançamento se ele NÃO estiver lá — nunca
// duplica, nunca apaga nada.
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;
  const transaction = await prisma.transaction.findFirst({
    where: { id, companyId: session.companyId },
    select: { id: true },
  });
  if (!transaction) {
    return NextResponse.json({ error: "Lançamento não encontrado." }, { status: 404 });
  }

  const result = await resyncTransactionToSheet(transaction.id);
  return NextResponse.json({ ok: true, result });
}
