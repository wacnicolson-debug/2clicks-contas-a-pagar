import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { resolveSupplier } from "@/lib/suppliers/resolveSupplier";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { normalizeText } from "@/lib/utils/normalizeText";

type ManualBody = {
  kind: "FORNECEDOR" | "CLIENTE";
  supplierName: string;
  taxId?: string;
  amount: number;
  dueDate: string; // AAAA-MM-DD
  paymentStatus?: "PAGO" | "A_PAGAR"; // só faz sentido pra FORNECEDOR
  paymentMethod?: "BOLETO" | "PIX" | "DEBITO_CONTA"; // idem
  pixKey?: string;
  categoryName?: string;
  noteNumber?: string;
};

// Lançamento sem documento nenhum por trás — pra coisas que não têm nota/
// comprovante pra escanear (ex: um lançamento que precisou ser refeito à
// mão, um débito recorrente já conhecido). Mesmo efeito de um lançamento
// vindo de documento: ensina o perfil do fornecedor e sincroniza a planilha.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = (await request.json()) as ManualBody;

  if (!body.supplierName?.trim() || !(body.amount > 0) || !body.dueDate) {
    return NextResponse.json(
      { error: "Preencha fornecedor/cliente, valor e data." },
      { status: 400 }
    );
  }

  const supplier = await resolveSupplier({
    companyId: session.companyId,
    nameRaw: body.supplierName.trim(),
    taxId: body.taxId?.trim() || null,
  });

  let categoryId: string | null = supplier.defaultCategoryId;
  if (body.categoryName?.trim()) {
    const name = body.categoryName.trim().toUpperCase();
    const normalizedName = normalizeText(name);
    const category =
      (await prisma.category.findUnique({
        where: { companyId_normalizedName: { companyId: session.companyId, normalizedName } },
      })) ??
      (await prisma.category.create({
        data: { companyId: session.companyId, name, normalizedName },
      }));
    categoryId = category.id;
  }

  // Grava o perfil aprendido, igual à tela de perguntas — a próxima vez que
  // esse nome aparecer (num documento, extrato ou relação), já vem pronto.
  const updatedSupplier = await prisma.supplier.update({
    where: { id: supplier.id },
    data: {
      kind: body.kind,
      defaultStatus: body.kind === "FORNECEDOR" ? body.paymentStatus : undefined,
      paymentMethod: body.kind === "FORNECEDOR" ? body.paymentMethod : undefined,
      pixKey: body.kind === "FORNECEDOR" && body.paymentMethod === "PIX" ? body.pixKey : undefined,
      defaultCategoryId: categoryId,
    },
  });

  const transaction = await prisma.transaction.create({
    data: {
      companyId: session.companyId,
      kind: body.kind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE",
      supplierId: updatedSupplier.id,
      amount: body.amount,
      dueDate: new Date(body.dueDate),
      paymentStatus: body.kind === "FORNECEDOR" ? body.paymentStatus : undefined,
      paymentMethod: body.kind === "FORNECEDOR" ? body.paymentMethod : undefined,
      pixKey: body.kind === "FORNECEDOR" && body.paymentMethod === "PIX" ? body.pixKey : undefined,
      categoryId,
      noteNumber: body.noteNumber?.trim() || null,
      paid: body.kind === "FORNECEDOR" && body.paymentStatus === "PAGO",
      createdByUserId: session.userId,
    },
  });

  await syncTransactionToSheet(transaction.id);

  return NextResponse.json({ ok: true, transactionId: transaction.id });
}
