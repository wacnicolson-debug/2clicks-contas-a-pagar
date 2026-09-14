import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { clearTransactionFromSheet } from "@/lib/sheets/syncTransaction";

export async function DELETE(
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
  });

  if (!transaction) {
    return NextResponse.json({ error: "Lançamento não encontrado." }, { status: 404 });
  }

  await clearTransactionFromSheet(transaction.id);
  await prisma.transaction.delete({ where: { id: transaction.id } });

  // Um lançamento excluído é sinal de que o "perfil aprendido" desse
  // fornecedor errou em algo — reseta pra ele voltar a perguntar tudo na
  // próxima nota, em vez de repetir o mesmo erro automaticamente.
  await prisma.supplier.update({
    where: { id: transaction.supplierId },
    data: {
      kind: null,
      defaultStatus: null,
      paymentMethod: null,
      pixKey: null,
      defaultCategoryId: null,
    },
  });

  return NextResponse.json({ ok: true });
}
