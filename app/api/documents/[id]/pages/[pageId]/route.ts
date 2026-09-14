import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { ExtractedPage } from "@/lib/ai/extractDocument";

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; pageId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id, pageId } = await ctx.params;

  const docPage = await prisma.documentPage.findFirst({
    where: { id: pageId, documentId: id, document: { companyId: session.companyId } },
    include: { supplier: true, document: true },
  });

  if (!docPage) {
    return NextResponse.json({ error: "Página não encontrada." }, { status: 404 });
  }

  const extraction = docPage.rawExtraction as unknown as ExtractedPage;

  return NextResponse.json({
    supplierName: docPage.supplier?.name ?? extraction.supplierNameRaw,
    supplierKnown: !!docPage.supplier?.kind,
    // Exceção: fornecedor já conhecido, mas a categoria muda nota a nota
    // (ex: mão de obra normal vs hora extra, notas visualmente idênticas) —
    // pergunta a categoria de novo mesmo sem repetir o resto do perfil.
    needsCategory: !!docPage.supplier?.alwaysAskCategory,
    // Linha de extrato bancário sem nota correspondente: o dinheiro já se
    // moveu na conta, então não faz sentido perguntar "Pago ou a pagar?".
    fromStatement: docPage.document.kind === "BANK_STATEMENT",
    installments: extraction.installments.map((i) => ({
      amount: i.amount,
      dueDate: i.dueDate,
    })),
  });
}

// Descarta uma página pendente (ainda não respondida) — nenhum lançamento
// chegou a ser criado pra ela, então basta apagar o registro. Se era a
// última página do documento, o documento também some (não faz sentido
// ficar um documento "vazio" pendurado no painel).
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; pageId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id, pageId } = await ctx.params;

  const docPage = await prisma.documentPage.findFirst({
    where: { id: pageId, documentId: id, document: { companyId: session.companyId } },
  });
  if (!docPage) {
    return NextResponse.json({ error: "Página não encontrada." }, { status: 404 });
  }

  await prisma.documentPage.delete({ where: { id: docPage.id } });

  const remainingPages = await prisma.documentPage.count({ where: { documentId: id } });
  if (remainingPages === 0) {
    await prisma.document.delete({ where: { id } });
  }

  return NextResponse.json({ ok: true });
}
