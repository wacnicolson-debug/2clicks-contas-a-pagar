import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { clearTransactionFromSheet, syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { normalizeText } from "@/lib/utils/normalizeText";

type PatchBody = {
  categoryName?: string;
  amount?: number;
  dueDate?: string; // AAAA-MM-DD
  noteNumber?: string | null;
  description?: string | null; // observação — vai pra coluna "Observações" da planilha
  paymentStatus?: "PAGO" | "A_PAGAR"; // fornecedor
  paid?: boolean; // cliente
};

// Corrige um lançamento já lançado (ex: categoria errada) sem precisar
// excluir e reenviar o documento inteiro — tira da planilha, atualiza no
// banco e recoloca no lugar certo (pode até mudar de aba/status se o que
// mudou for o vencimento ou o "pago"). Ao contrário do DELETE, não reseta
// o perfil aprendido do fornecedor — é só uma correção pontual.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;
  const body = (await request.json()) as PatchBody;

  const transaction = await prisma.transaction.findFirst({
    where: { id, companyId: session.companyId },
  });
  if (!transaction) {
    return NextResponse.json({ error: "Lançamento não encontrado." }, { status: 404 });
  }

  let categoryId = transaction.categoryId;
  if (typeof body.categoryName === "string") {
    const trimmed = body.categoryName.trim();
    if (trimmed) {
      const name = trimmed.toUpperCase();
      const normalizedName = normalizeText(name);
      const category = await prisma.category.upsert({
        where: { companyId_normalizedName: { companyId: session.companyId, normalizedName } },
        update: {},
        create: { companyId: session.companyId, name, normalizedName },
      });
      categoryId = category.id;
    } else {
      categoryId = null;
    }
  }

  const amount =
    typeof body.amount === "number" && body.amount > 0 ? body.amount : Number(transaction.amount);
  const dueDate = body.dueDate ? new Date(body.dueDate) : transaction.dueDate;
  const noteNumber =
    body.noteNumber !== undefined ? body.noteNumber?.trim() || null : transaction.noteNumber;
  const description =
    body.description !== undefined ? body.description?.trim() || null : transaction.description;

  let paymentStatus = transaction.paymentStatus;
  let paid = transaction.paid;
  if (transaction.kind === "PAYABLE" && body.paymentStatus) {
    paymentStatus = body.paymentStatus;
    paid = body.paymentStatus === "PAGO";
  } else if (transaction.kind === "RECEIVABLE" && typeof body.paid === "boolean") {
    paid = body.paid;
  }

  // Tira da posição atual (bloco do dia, Custos Pagos ou Recebimentos) antes
  // de mudar os dados — senão a linha antiga fica órfã na planilha.
  await clearTransactionFromSheet(transaction.id);

  const updated = await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      categoryId,
      amount,
      dueDate,
      noteNumber,
      description,
      paymentStatus,
      paid,
      sheetSyncStatus: "PENDING",
      sheetCellRef: null,
      costLogCellRef: null,
    },
  });

  // Recoloca já com os dados novos — decide de novo pra onde vai (o
  // vencimento ou o "pago" podem ter mudado o destino certo).
  await syncTransactionToSheet(updated.id);

  return NextResponse.json({ ok: true });
}

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
