import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import { extractPaymentListLines } from "@/lib/ai/extractPaymentList";
import { resolveSupplier, needsOnboardingQuestions } from "@/lib/suppliers/resolveSupplier";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";

/**
 * Processa 1 relação de pagamentos já feitos ("Adicionar Relação de
 * Pagamentos" — lista de boletos pagos e/ou pix enviados). Cada linha vira
 * um lançamento já PAGO, igual ao fluxo de linha de extrato sem nota
 * correspondente (mesmo resolveSupplier, mesma automação). A diferença é
 * que aqui a linha é a PRÓPRIA fonte da cobrança, não algo que se tenta
 * casar contra lançamentos existentes — é o extrato, enviado depois, que
 * vai casar contra os lançamentos criados aqui (ver processStatement).
 */
export const processPaymentList = inngest.createFunction(
  { id: "process-payment-list", retries: 3, triggers: [{ event: "payment-list/uploaded" }] },
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

    let lines;
    try {
      lines = await step.run("extract-with-ai", async () => {
        const fileBuffer = await downloadDocumentFile(document.storagePath);
        return extractPaymentListLines({
          fileBase64: fileBuffer.toString("base64"),
          mimeType: document.mimeType,
        });
      });
    } catch (err) {
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "ERROR", processedAt: new Date() },
      });
      throw new NonRetriableError(
        err instanceof Error ? err.message : "Falha ao ler a relação de pagamentos."
      );
    }

    let anyAwaitingInput = false;

    for (const line of lines) {
      await step.run(`persist-line-${line.lineNumber}`, async () => {
        const lineDate = new Date(line.date);

        const supplier = await resolveSupplier({
          companyId: document.companyId,
          nameRaw: line.payeeNameRaw,
          taxId: line.taxId,
        });

        // Mesmo favorecido + mesma data + mesmo valor já lançado antes
        // (nota lançada via "Adicionar Documentos", linha já processada de
        // uma relação enviada antes, ou a mesma relação reenviada por
        // engano) — não duplica, só ignora esta linha.
        const alreadyLaunched = await prisma.transaction.findFirst({
          where: {
            companyId: document.companyId,
            supplierId: supplier.id,
            dueDate: lineDate,
            amount: line.amount,
          },
        });
        if (alreadyLaunched) {
          return;
        }

        const needsInput = needsOnboardingQuestions(supplier) || supplier.alwaysAskCategory;

        const docPage = await prisma.documentPage.create({
          data: {
            documentId: document.id,
            pageNumber: line.lineNumber,
            rawExtraction: {
              pageNumber: line.lineNumber,
              supplierNameRaw: line.payeeNameRaw,
              taxId: line.taxId,
              noteNumber: line.noteNumber,
              installments: [{ amount: line.amount, dueDate: line.date }],
              confidence: 1,
              notes: `Pagamento (${line.paymentMethod}) lido de relação de pagamentos.`,
              duplicateOfPageNumber: null,
            },
            supplierId: supplier.id,
            confidence: 1,
            status: needsInput ? "AWAITING_USER_INPUT" : "DONE",
          },
        });

        if (needsInput) {
          anyAwaitingInput = true;
          return; // aguarda o usuário responder na tela de perguntas
        }

        // Fornecedor já conhecido: lança automático, sempre como Pago (o
        // dinheiro já saiu da conta — é isso que essa lista representa).
        const transaction = await prisma.transaction.create({
          data: {
            companyId: document.companyId,
            kind: supplier.kind === "CLIENTE" ? "RECEIVABLE" : "PAYABLE",
            documentId: document.id,
            documentPageId: docPage.id,
            supplierId: supplier.id,
            amount: line.amount,
            dueDate: lineDate,
            paymentStatus: "PAGO",
            paymentMethod: line.paymentMethod,
            pixKey: supplier.pixKey,
            categoryId: supplier.defaultCategoryId,
            noteNumber: line.noteNumber,
            paid: true,
            createdByUserId: document.uploadedById,
          },
        });
        await syncTransactionToSheet(transaction.id);
      });
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

    return { linesProcessed: lines.length, anyAwaitingInput };
  }
);
