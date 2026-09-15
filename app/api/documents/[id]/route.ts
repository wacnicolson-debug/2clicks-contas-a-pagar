import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { ExtractedPage } from "@/lib/ai/extractDocument";
import { clearTransactionFromSheet } from "@/lib/sheets/syncTransaction";

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;

  const document = await prisma.document.findFirst({
    where: { id, companyId: session.companyId },
    include: {
      pages: { include: { supplier: true }, orderBy: { pageNumber: "asc" } },
    },
  });

  if (!document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  // Linhas do extrato que bateram com uma nota já lançada não geram
  // DocumentPage nenhuma — só aparecem aqui, pra ficar visível que foram
  // conferidas (as órfãs já aparecem via `pages`, criadas pra elas).
  const matchedLines =
    document.kind === "BANK_STATEMENT"
      ? await prisma.bankStatementLine.findMany({
          where: { documentId: id, status: "MATCHED" },
          orderBy: { date: "asc" },
        })
      : [];

  return NextResponse.json({
    id: document.id,
    status: document.status,
    originalFilename: document.originalFilename,
    pages: document.pages.map((p) => {
      const extraction = p.rawExtraction as unknown as ExtractedPage;
      return {
        id: p.id,
        pageNumber: p.pageNumber,
        status: p.status,
        supplierName: p.supplier?.name ?? null,
        duplicateOfPageNumber: extraction?.duplicateOfPageNumber ?? null,
      };
    }),
    matchedLines: matchedLines.map((l) => ({
      id: l.id,
      description: l.rawDescription,
      amount: Number(l.amount),
      date: l.date.toISOString().slice(0, 10),
    })),
  });
}

// Desfaz um envio inteiro (ex: arquivo subido pelo botão errado, ou relação
// enviada com dado ruim) — apaga os lançamentos já criados a partir dele
// (limpando a planilha e resetando o perfil dos fornecedores afetados, igual
// à exclusão individual), as páginas e o documento, liberando o hash do
// arquivo pra poder ser reenviado do jeito certo.
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;

  const document = await prisma.document.findFirst({
    where: { id, companyId: session.companyId },
  });
  if (!document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  const transactions = await prisma.transaction.findMany({ where: { documentId: id } });
  for (const transaction of transactions) {
    await clearTransactionFromSheet(transaction.id);
    await prisma.transaction.delete({ where: { id: transaction.id } });
    // Mesmo raciocínio da exclusão individual: um lançamento que precisou
    // ser desfeito é sinal de que o perfil aprendido desse fornecedor errou
    // em algo — reseta pra perguntar tudo de novo na próxima.
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
  }

  await prisma.bankStatementLine.deleteMany({ where: { documentId: id } });
  await prisma.documentPage.deleteMany({ where: { documentId: id } });
  await prisma.document.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
