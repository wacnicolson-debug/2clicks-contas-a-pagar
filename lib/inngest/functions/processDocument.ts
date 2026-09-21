import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import { extractDocumentPages } from "@/lib/ai/extractDocument";
import { resolveSupplier, needsOnboardingQuestions } from "@/lib/suppliers/resolveSupplier";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";

export const processDocument = inngest.createFunction(
  { id: "process-document", retries: 3, triggers: [{ event: "document/uploaded" }] },
  async ({ event, step }) => {
    const { documentId } = event.data;

    const document = await step.run("load-document", async () => {
      return prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    });

    await step.run("mark-processing", () =>
      prisma.document.update({
        where: { id: documentId },
        data: { status: "PROCESSING" },
      })
    );

    let extractedPages;
    try {
      extractedPages = await step.run("extract-with-ai", async () => {
        const fileBuffer = await downloadDocumentFile(document.storagePath);
        return extractDocumentPages({
          fileBase64: fileBuffer.toString("base64"),
          mimeType: document.mimeType,
        });
      });
    } catch (err) {
      // Falha definitiva de leitura (ex: PDF corrompido/inválido) — sem isso o
      // documento ficava travado em "Lendo com IA..." pra sempre, sem nenhum
      // aviso na tela. Marca erro e não deixa o Inngest tentar de novo (um
      // arquivo inválido não vira válido só por tentar de novo).
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "ERROR", processedAt: new Date() },
      });
      throw new NonRetriableError(
        err instanceof Error ? err.message : "Falha ao ler o documento."
      );
    }

    let anyAwaitingInput = false;

    for (const page of extractedPages) {
      // Só cria os registros no banco (DocumentPage + Transaction) — a
      // sincronização com a planilha fica num step separado, mais abaixo:
      // se ela falhar (ex: erro do Google) o Inngest tenta de novo só o
      // step de sync, sem re-executar esta criação (que já ficou memorizada
      // como concluída) — evita duplicar o lançamento inteiro no retry, e
      // evita o oposto também (retry pulando a sincronização pra sempre
      // porque a checagem de "já lançado" abaixo acharia a transação já
      // criada na tentativa anterior).
      const result = await step.run(`persist-page-${page.pageNumber}`, async () => {
        if (page.duplicateOfPageNumber) {
          // 2ª/3ª via, folha de continuação, ou anexo sem cobrança própria da
          // mesma nota de uma página anterior — só registra, não lança de novo.
          await prisma.documentPage.create({
            data: {
              documentId: document.id,
              pageNumber: page.pageNumber,
              rawExtraction: page as unknown as object,
              confidence: page.confidence,
              status: "DONE",
            },
          });
          return { needsInput: false, transactionIds: [] as string[] };
        }

        const supplier = await resolveSupplier({
          companyId: document.companyId,
          nameRaw: page.supplierNameRaw,
          taxId: page.taxId,
        });

        // Sentido lido da própria nota (emitente/destinatário) bate diferente
        // do que já estava aprendido pra esse fornecedor — ele é dos dois
        // lados (compra E vende), então não dá pra confiar no perfil salvo
        // pra ESTA nota específica. Força perguntar de novo, com o sentido
        // certo já pré-marcado (ver knownKind), sem mexer no perfil salvo —
        // a próxima compra de verdade continua vindo automática.
        const documentKind =
          page.documentDirection === "VENDA"
            ? "CLIENTE"
            : page.documentDirection === "COMPRA"
              ? "FORNECEDOR"
              : null;
        const directionConflict = !!(documentKind && supplier.kind && documentKind !== supplier.kind);

        // Fornecedor conhecido mas a nota não trouxe vencimento nenhum: não dá
        // pra lançar automático sem data (regra: só pergunta quando falta mesmo),
        // então essa página também para na tela de perguntas — só que lá ela vai
        // pedir apenas a data, sem repetir as 3 perguntas de classificação.
        const missingDate = page.installments.some((i) => !i.dueDate);
        const needsInput =
          needsOnboardingQuestions(supplier) ||
          missingDate ||
          supplier.alwaysAskCategory ||
          directionConflict;

        const docPage = await prisma.documentPage.create({
          data: {
            documentId: document.id,
            pageNumber: page.pageNumber,
            rawExtraction: {
              ...page,
              knownKind: documentKind ?? page.knownKind ?? null,
              directionConflict,
            } as unknown as object,
            supplierId: supplier.id,
            confidence: page.confidence,
            status: needsInput ? "AWAITING_USER_INPUT" : "DONE",
          },
        });

        if (needsInput) {
          return { needsInput: true, transactionIds: [] as string[] };
        }

        // Fornecedor já conhecido: lança automático, sem perguntar de novo.
        const transactionIds: string[] = [];
        for (const [index, installment] of page.installments.entries()) {
          // Mesmo fornecedor + mesma data + mesmo valor já lançado antes (nota
          // repetida num arquivo diferente, ou o próprio arquivo reenviado com
          // outro nome/formato) — não duplica, retoma a sincronização dela
          // em vez de criar de novo (cobre tanto reenvio de arquivo quanto
          // um retry deste mesmo step que já tinha criado na tentativa anterior).
          const alreadyLaunched = await prisma.transaction.findFirst({
            where: {
              companyId: document.companyId,
              supplierId: supplier.id,
              dueDate: new Date(installment.dueDate!),
              amount: installment.amount,
            },
          });
          if (alreadyLaunched) {
            transactionIds.push(alreadyLaunched.id);
            continue;
          }

          const transaction = await prisma.transaction.create({
            data: {
              companyId: document.companyId,
              kind: supplier.kind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE",
              documentId: document.id,
              documentPageId: docPage.id,
              supplierId: supplier.id,
              amount: installment.amount,
              dueDate: new Date(installment.dueDate!), // garantido acima (needsInput cobre data faltante)
              // "Pago" não é um traço estável do fornecedor como a categoria
              // é — é um fato de cada cobrança específica. Uma nota nova
              // lançada automático (fornecedor já conhecido) é sempre uma
              // obrigação nova, nunca deve nascer marcada como já paga só
              // porque uma nota ANTERIOR desse fornecedor foi.
              paymentStatus: "A_PAGAR",
              paymentMethod: supplier.paymentMethod ?? undefined,
              pixKey: supplier.pixKey,
              categoryId: supplier.defaultCategoryId,
              installmentIndex: page.installments.length > 1 ? index + 1 : null,
              installmentTotal: page.installments.length > 1 ? page.installments.length : null,
              noteNumber: page.noteNumber,
              paid: false,
              createdByUserId: document.uploadedById,
            },
          });
          transactionIds.push(transaction.id);
        }
        return { needsInput: false, transactionIds };
      });

      if (result.needsInput) {
        anyAwaitingInput = true;
        continue;
      }

      for (const transactionId of result.transactionIds) {
        await step.run(`sync-sheet-${page.pageNumber}-${transactionId}`, () =>
          syncTransactionToSheet(transactionId)
        );
      }
    }

    await step.run("finalize-document-status", () =>
      prisma.document.update({
        where: { id: documentId },
        data: {
          status: anyAwaitingInput ? "AWAITING_USER_INPUT" : "DONE",
          processedAt: new Date(),
        },
      })
    );

    return { pagesProcessed: extractedPages.length, anyAwaitingInput };
  }
);
