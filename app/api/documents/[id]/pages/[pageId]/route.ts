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

  // Fornecedor que compra E vende (perfil salvo bate diferente do sentido
  // desta nota específica): trata como "não conhecido" só pra essa pergunta
  // reaparecer, sem repetir a onboarding inteira de categoria/pagamento —
  // ver directionConflict, calculado no processamento.
  const directionConflict = !!extraction.directionConflict;

  return NextResponse.json({
    supplierName: docPage.supplier?.name ?? extraction.supplierNameRaw,
    supplierKnown: !!docPage.supplier?.kind && !directionConflict,
    directionConflict,
    // Exceção: fornecedor já conhecido, mas a categoria muda nota a nota
    // (ex: mão de obra normal vs hora extra, notas visualmente idênticas) —
    // pergunta a categoria de novo mesmo sem repetir o resto do perfil.
    needsCategory: !!docPage.supplier?.alwaysAskCategory,
    // Linha de extrato bancário ou de relação de pagamentos: o dinheiro já
    // se moveu na conta, então não faz sentido perguntar "Pago ou a pagar?".
    fromStatement: docPage.document.kind !== "INVOICES",
    // Só vem preenchido quando a forma de pagamento já foi lida da própria
    // relação de pagamentos — pré-marca a pergunta em vez de nascer sempre
    // em "Boleto".
    knownPaymentMethod: extraction.knownPaymentMethod ?? null,
    knownPixKey: extraction.knownPixKey ?? null,
    knownKind: extraction.knownKind ?? null,
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
