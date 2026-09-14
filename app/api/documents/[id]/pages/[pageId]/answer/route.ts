import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { rebuildCostSummaryTab } from "@/lib/sheets/rebuildCostSummary";
import { normalizeText } from "@/lib/utils/normalizeText";
import type { ExtractedPage } from "@/lib/ai/extractDocument";

type AnswerBody = {
  kind: "FORNECEDOR" | "CLIENTE";
  paymentStatus?: "PAGO" | "A_PAGAR";
  paymentMethod?: "BOLETO" | "PIX" | "DEBITO_CONTA";
  pixKey?: string;
  categoryName?: string;
  // Marcado só na 1ª nota do fornecedor — sinaliza que notas dele mudam de
  // categoria (ex: mão de obra normal vs hora extra, aparência idêntica),
  // então a categoria passa a ser perguntada de novo em toda nota futura.
  alwaysAskCategory?: boolean;
  // Preenchido pelo usuário só quando a nota não trazia vencimento visível —
  // uma data por índice de parcela (uma nota parcelada pode ter mais de uma
  // parcela sem data, cada uma com seu próprio vencimento).
  manualDueDates?: Record<number, string>;
  // Preenchido só quando o usuário divide manualmente 1 valor cheio lido da
  // nota em várias parcelas (documento não trazia nenhuma indicação disso,
  // ex: nota mandada por WhatsApp) — substitui extraction.installments por
  // completo quando presente.
  installmentsOverride?: { amount: number; dueDate: string }[];
  // Opcional: data real da compra/venda, quando diferente do vencimento (nota
  // de prazo longo lançada com atraso) — ver Transaction.noteDate no schema.
  noteDate?: string;
};

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; pageId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id, pageId } = await ctx.params;
  const body = (await request.json()) as AnswerBody;

  const docPage = await prisma.documentPage.findFirst({
    where: { id: pageId, documentId: id, document: { companyId: session.companyId } },
    include: { supplier: true, document: true },
  });

  if (!docPage || !docPage.supplier) {
    return NextResponse.json({ error: "Página não encontrada." }, { status: 404 });
  }

  // categoryId só muda se o usuário de fato mandou uma categoria nesta resposta
  // (fornecedor já conhecido, pedindo só a data, não reenvia categoria nenhuma).
  let categoryId: string | null | undefined = undefined;
  let isNewCategory = false;
  if (body.categoryName?.trim()) {
    // Sempre maiúscula (padrão estético pedido pelo usuário), e comparada sem
    // acento/pontuação/caixa — evita "Energia" vs "ENERGIA" e "matéria-prima
    // - tecidos" vs "matéria prima - tecidos" virarem categorias diferentes
    // e espalharem o total em vez de somar junto.
    const name = body.categoryName.trim().toUpperCase();
    const normalizedName = normalizeText(name);
    const existingCategory = await prisma.category.findUnique({
      where: { companyId_normalizedName: { companyId: session.companyId, normalizedName } },
    });
    isNewCategory = !existingCategory;
    const category =
      existingCategory ??
      (await prisma.category.create({
        data: { companyId: session.companyId, name, normalizedName },
      }));
    categoryId = category.id;
  }

  // Grava o "perfil aprendido" do fornecedor — a partir da próxima nota,
  // isso é aplicado automaticamente, sem perguntar de novo. Campos não
  // enviados (undefined) simplesmente não mudam o que já estava salvo —
  // é assim que cobrimos o caso "fornecedor já conhecido, só falta a data".
  const supplier = await prisma.supplier.update({
    where: { id: docPage.supplierId! },
    data: {
      kind: body.kind,
      defaultStatus: body.kind === "FORNECEDOR" ? body.paymentStatus : undefined,
      paymentMethod: body.kind === "FORNECEDOR" ? body.paymentMethod : undefined,
      pixKey: body.kind === "FORNECEDOR" && body.paymentMethod === "PIX" ? body.pixKey : undefined,
      defaultCategoryId: categoryId,
      alwaysAskCategory: body.alwaysAskCategory,
    },
  });

  const extraction = docPage.rawExtraction as unknown as ExtractedPage;
  const kindKey = supplier.kind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE";

  // Divisão manual (usuário informou que o valor cheio lido é na verdade
  // várias parcelas) substitui as parcelas lidas por completo.
  const installments: { amount: number; dueDate: string | null }[] =
    body.installmentsOverride ?? extraction.installments;

  if (body.installmentsOverride) {
    const invalid = body.installmentsOverride.some((i) => !i.dueDate || !(i.amount > 0));
    if (invalid) {
      return NextResponse.json(
        { error: "Preencha valor e vencimento de todas as parcelas." },
        { status: 400 }
      );
    }
  } else {
    // Se a nota não trouxe vencimento em algum parcelamento, a data digitada pelo
    // usuário é obrigatória pra CADA parcela sem data — nunca lançamos escondendo
    // isso atrás da data de hoje, nem aplicando a mesma data pra parcelas diferentes.
    const missingDateIndexes = installments
      .map((i, idx) => (i.dueDate ? null : idx))
      .filter((idx): idx is number => idx !== null);
    if (missingDateIndexes.some((idx) => !body.manualDueDates?.[idx])) {
      return NextResponse.json(
        { error: "Essa nota não tem data de vencimento visível — informe a data de cada parcela." },
        { status: 400 }
      );
    }
  }

  const createdIds: string[] = [];
  const affectedYears = new Set<number>();
  const noteDate = body.noteDate ? new Date(body.noteDate) : null;
  for (const [index, installment] of installments.entries()) {
    const dueDateStr = installment.dueDate ?? body.manualDueDates![index];
    affectedYears.add(new Date(dueDateStr).getUTCFullYear());
    if (noteDate) affectedYears.add(noteDate.getUTCFullYear());
    const transaction = await prisma.transaction.create({
      data: {
        companyId: session.companyId,
        kind: kindKey,
        documentId: docPage.documentId,
        documentPageId: docPage.id,
        supplierId: supplier.id,
        amount: installment.amount,
        dueDate: new Date(dueDateStr),
        noteDate,
        paymentStatus: supplier.kind === "FORNECEDOR" ? (supplier.defaultStatus ?? undefined) : undefined,
        paymentMethod: supplier.kind === "FORNECEDOR" ? (supplier.paymentMethod ?? undefined) : undefined,
        pixKey: supplier.kind === "FORNECEDOR" && supplier.paymentMethod === "PIX" ? supplier.pixKey : undefined,
        categoryId: supplier.defaultCategoryId,
        installmentIndex: installments.length > 1 ? index + 1 : null,
        installmentTotal: installments.length > 1 ? installments.length : null,
        noteNumber: extraction.noteNumber,
        paid: supplier.kind === "FORNECEDOR" && supplier.defaultStatus === "PAGO",
        createdByUserId: session.userId,
      },
    });
    createdIds.push(transaction.id);
  }

  for (const transactionId of createdIds) {
    await syncTransactionToSheet(transactionId);
  }

  // Se essa página veio de uma linha de extrato bancário sem nota
  // correspondente, marca a linha como classificada — não-op pra páginas de
  // notas normais (nenhuma BankStatementLine aponta pra elas).
  if (createdIds.length > 0) {
    await prisma.bankStatementLine.updateMany({
      where: { documentPageId: docPage.id },
      data: { status: "CLASSIFIED", matchedTransactionId: createdIds[0] },
    });
  }

  if (isNewCategory) {
    // Categoria nova: a aba "Classificação de Custos" (da planilha de cada
    // ano afetado) precisa ganhar uma linha pra ela — não bloqueia o
    // lançamento se falhar.
    for (const year of affectedYears) {
      try {
        await rebuildCostSummaryTab(session.companyId, year);
      } catch (err) {
        console.error(`Falha ao reconstruir a aba de Classificação de Custos (${year}):`, err);
      }
    }
  }

  await prisma.documentPage.update({ where: { id: docPage.id }, data: { status: "DONE" } });

  const remainingPages = await prisma.documentPage.count({
    where: { documentId: docPage.documentId, status: { not: "DONE" } },
  });
  if (remainingPages === 0) {
    await prisma.document.update({
      where: { id: docPage.documentId },
      data: { status: "DONE", processedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
