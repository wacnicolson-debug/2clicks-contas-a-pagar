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

  try {
    const result = await resyncTransactionToSheet(transaction.id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // Devolve o motivo real (ex: dia com mais de 30 lançamentos, Google fora
    // do ar) em vez de um "tente de novo" genérico.
    console.error(`Falha ao reenviar o lançamento ${transaction.id} pra planilha:`, err);
    const message = err instanceof Error ? err.message : "erro desconhecido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
