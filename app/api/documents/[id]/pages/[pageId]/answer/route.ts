import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { rebuildCostSummaryTab } from "@/lib/sheets/rebuildCostSummary";
import { rebuildBudgetTab } from "@/lib/sheets/budgetSheet";
import { normalizeText } from "@/lib/utils/normalizeText";
import type { ExtractedPage } from "@/lib/ai/extractDocument";
import type { Supplier } from "@prisma/client";

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
  // Observação livre do usuário — vai direto pra coluna "Observações" da
  // planilha, pra não precisar editar lá depois.
  description?: string;
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

  if (docPage.status === "DONE") {
    // Página já respondida antes — reenvio do formulário (duplo clique, ou
    // usuário tentando de novo depois de um erro que na verdade já tinha
    // completado). Não cria lançamento novo, só confirma que já está feito.
    return NextResponse.json({ ok: true });
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

  const extraction = docPage.rawExtraction as unknown as ExtractedPage;

  // Esse fornecedor compra E vende (o sentido lido nesta nota bate diferente
  // do perfil já salvo) — não grava por cima do perfil, senão a próxima
  // compra de verdade dele viria errada. Usa a resposta só pra ESTE
  // lançamento, deixando o cadastro do fornecedor intocado.
  const directionConflict = !!extraction.directionConflict;

  const supplier = directionConflict
    ? docPage.supplier
    : await prisma.supplier.update({
        // Grava o "perfil aprendido" do fornecedor — a partir da próxima nota,
        // isso é aplicado automaticamente, sem perguntar de novo. Campos não
        // enviados (undefined) simplesmente não mudam o que já estava salvo —
        // é assim que cobrimos o caso "fornecedor já conhecido, só falta a data".
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

  // Em conflito de sentido, usa exatamente o que foi respondido agora pra
  // este lançamento (não o que já estava salvo no perfil, que é do sentido
  // oposto); no caso normal, os dois já são a mesma coisa.
  const effectiveKind = directionConflict ? body.kind : supplier.kind;
  // "Pago" é fato de cada cobrança, não do fornecedor: sem resposta explícita
  // nesta tela (fornecedor já conhecido), nota nova nasce "A pagar" — herdar o
  // perfil mandava pro histórico de pagos nota que ainda não foi paga. Linha
  // de extrato/relação de pagamentos é diferente: o dinheiro já saiu.
  const isStatementSource = docPage.document.kind !== "INVOICES";
  const effectivePaymentStatus: "PAGO" | "A_PAGAR" =
    body.paymentStatus ?? (isStatementSource ? "PAGO" : "A_PAGAR");
  const effectivePaymentMethod = directionConflict ? body.paymentMethod : supplier.paymentMethod;
  const effectivePixKey = directionConflict ? body.pixKey : supplier.pixKey;
  const effectiveCategoryId = directionConflict ? (categoryId ?? null) : supplier.defaultCategoryId;

  const kindKey = effectiveKind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE";

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

  const noteDate = body.noteDate ? new Date(body.noteDate) : null;
  const affectedYears = new Set<number>();

  // Se uma tentativa anterior já criou os lançamentos dessa página mas não
  // terminou (ex: erro ao sincronizar com a planilha — Google fora do ar,
  // token expirado etc — a página fica sem status DONE e permite reenvio),
  // não cria tudo de novo: só retoma os que já existem. Sem isso, cada
  // reenvio duplicava o lançamento inteiro.
  const existingTransactions = await prisma.transaction.findMany({
    where: { documentPageId: docPage.id },
  });

  let createdIds: string[];
  if (existingTransactions.length > 0) {
    createdIds = existingTransactions.map((t) => t.id);
    for (const t of existingTransactions) {
      affectedYears.add(t.dueDate.getUTCFullYear());
      if (t.noteDate) affectedYears.add(t.noteDate.getUTCFullYear());
    }
  } else {
    createdIds = [];
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
          description: body.description?.trim() || null,
          paymentStatus: effectiveKind === "FORNECEDOR" ? (effectivePaymentStatus ?? undefined) : undefined,
          paymentMethod: effectiveKind === "FORNECEDOR" ? (effectivePaymentMethod ?? undefined) : undefined,
          pixKey: effectiveKind === "FORNECEDOR" && effectivePaymentMethod === "PIX" ? effectivePixKey : undefined,
          categoryId: effectiveCategoryId,
          installmentIndex: installments.length > 1 ? index + 1 : null,
          installmentTotal: installments.length > 1 ? installments.length : null,
          noteNumber: extraction.noteNumber,
          paid: effectiveKind === "FORNECEDOR" && effectivePaymentStatus === "PAGO",
          createdByUserId: session.userId,
        },
      });
      createdIds.push(transaction.id);
    }
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
      try {
        await rebuildBudgetTab(session.companyId, year);
      } catch (err) {
        console.error(`Falha ao reconstruir a aba de Orçamento (${year}):`, err);
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

  // Esse mesmo fornecedor pode ter OUTRAS linhas pendentes da mesma leva (ex:
  // vários pix pro mesmo favorecido numa relação de pagamentos — cada linha
  // virou uma pergunta separada porque nenhuma sabia do perfil dele ainda).
  // Agora que o perfil acabou de ser confirmado, resolve elas sozinho — só
  // fica pendente o que realmente falta o usuário decidir (data, ou
  // categoria pra fornecedor marcado como "muda de categoria nota a nota").
  // Em conflito de sentido o perfil nem mudou, então não faz sentido
  // resolver as outras pendências dele com base nesta resposta.
  if (!supplier.alwaysAskCategory && !directionConflict) {
    await resolveOtherPendingPagesForSupplier(
      supplier,
      session.userId,
      isStatementSource ? "A_PAGAR" : effectivePaymentStatus
    );
  }

  return NextResponse.json({ ok: true });
}

async function resolveOtherPendingPagesForSupplier(
  supplier: Supplier,
  createdByUserId: string,
  invoiceStatus: "PAGO" | "A_PAGAR"
) {
  const otherPendingPages = await prisma.documentPage.findMany({
    where: { supplierId: supplier.id, status: "AWAITING_USER_INPUT" },
    include: { document: { select: { companyId: true, kind: true } } },
  });

  const kindKey = supplier.kind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE";

  for (const page of otherPendingPages) {
    const extraction = page.rawExtraction as unknown as ExtractedPage;
    const missingDate = extraction.installments.some((i) => !i.dueDate);
    if (missingDate) continue; // só o usuário sabe essa data, continua pendente

    // Extrato/relação de pagamentos: já foi pago. Nota: só o que foi respondido agora.
    const pageStatus: "PAGO" | "A_PAGAR" =
      page.document.kind !== "INVOICES" ? "PAGO" : invoiceStatus;

    // Mesma proteção contra duplicata do handler principal: se uma tentativa
    // anterior já criou os lançamentos dessa página (mas travou antes de
    // marcar DONE, ex: falha ao sincronizar), retoma em vez de criar de novo.
    const existingForPage = await prisma.transaction.findMany({
      where: { documentPageId: page.id },
    });

    const createdIds: string[] = existingForPage.length > 0 ? existingForPage.map((t) => t.id) : [];
    if (existingForPage.length === 0) {
      for (const [index, installment] of extraction.installments.entries()) {
        const transaction = await prisma.transaction.create({
          data: {
            companyId: page.document.companyId,
            kind: kindKey,
            documentId: page.documentId,
            documentPageId: page.id,
            supplierId: supplier.id,
            amount: installment.amount,
            dueDate: new Date(installment.dueDate!),
            paymentStatus: supplier.kind === "FORNECEDOR" ? pageStatus : undefined,
            paymentMethod: supplier.kind === "FORNECEDOR" ? (supplier.paymentMethod ?? undefined) : undefined,
            pixKey: supplier.kind === "FORNECEDOR" && supplier.paymentMethod === "PIX" ? supplier.pixKey : undefined,
            categoryId: supplier.defaultCategoryId,
            installmentIndex: extraction.installments.length > 1 ? index + 1 : null,
            installmentTotal: extraction.installments.length > 1 ? extraction.installments.length : null,
            noteNumber: extraction.noteNumber,
            paid: supplier.kind === "FORNECEDOR" && pageStatus === "PAGO",
            createdByUserId,
          },
        });
        createdIds.push(transaction.id);
      }
    }

    for (const transactionId of createdIds) {
      await syncTransactionToSheet(transactionId);
    }

    if (createdIds.length > 0) {
      await prisma.bankStatementLine.updateMany({
        where: { documentPageId: page.id },
        data: { status: "CLASSIFIED", matchedTransactionId: createdIds[0] },
      });
    }

    await prisma.documentPage.update({ where: { id: page.id }, data: { status: "DONE" } });

    const remaining = await prisma.documentPage.count({
      where: { documentId: page.documentId, status: { not: "DONE" } },
    });
    if (remaining === 0) {
      await prisma.document.update({
        where: { id: page.documentId },
        data: { status: "DONE", processedAt: new Date() },
      });
    }
  }
}
