import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import {
  clearTransactionFromSheet,
  sheetDestinationKey,
  syncTransactionToSheet,
  updateTransactionRowInPlace,
} from "@/lib/sheets/syncTransaction";
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
    include: { document: true },
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

  // Corrigir categoria, valor, nº da nota ou observação altera a linha que já
  // existe, no mesmo lugar. Só muda de lugar (tira da atual e coloca de novo)
  // se o vencimento ou o "pago" mudarem o destino — ou se o lançamento tem
  // também uma linha extra de custo em outro mês (nota de prazo longo).
  const fromPaymentList = transaction.document?.kind === "PAYMENT_LIST";
  const sameDestination =
    sheetDestinationKey({
      kind: transaction.kind,
      dueDate: transaction.dueDate,
      noteDate: transaction.noteDate,
      paid: transaction.paid,
      fromPaymentList,
    }) ===
    sheetDestinationKey({
      kind: transaction.kind,
      dueDate,
      noteDate: transaction.noteDate,
      paid,
      fromPaymentList,
    });
  const inPlace = sameDestination && !transaction.costLogCellRef;
  const previousAmount = Number(transaction.amount);

  if (!inPlace) {
    // Tira da posição atual antes de mudar os dados (senão a linha antiga
    // fica órfã na planilha) — o clear confere o conteúdo com os dados antigos.
    await clearTransactionFromSheet(transaction.id);
  }

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
      ...(inPlace ? {} : { sheetCellRef: null, costLogCellRef: null }),
    },
  });

  // O que foi feito na planilha, devolvido pra tela avisar o usuário — assim
  // dá pra ver na hora se atualizou a linha existente ou gravou uma nova.
  let action: "updated" | "created" | "moved";
  if (inPlace) {
    const updatedInPlace = await updateTransactionRowInPlace(updated.id, previousAmount);
    if (updatedInPlace) {
      action = "updated";
    } else {
      // Linha não encontrada na planilha (apagada/movida por fora): não há o que
      // corrigir, então grava como nova — sem apagar nada.
      await syncTransactionToSheet(updated.id);
      action = "created";
    }
  } else {
    await syncTransactionToSheet(updated.id);
    action = "moved";
  }

  const finalRef = await prisma.transaction.findUnique({
    where: { id: updated.id },
    select: { sheetCellRef: true },
  });
  const [tab, cell] = (finalRef?.sheetCellRef ?? "").split("!");

  return NextResponse.json({
    ok: true,
    sheet: { action, tab: tab || null, row: Number(cell?.match(/\d+/)?.[0]) || null },
  });
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
