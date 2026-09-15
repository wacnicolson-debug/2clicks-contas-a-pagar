import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import { extractPaymentListLines, ExtractedPaymentLine } from "@/lib/ai/extractPaymentList";
import { resolveSupplier, needsOnboardingQuestions } from "@/lib/suppliers/resolveSupplier";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { normalizeText } from "@/lib/utils/normalizeText";

// Chave de "impressão digital" de um pagamento: data+valor+favorecido
// normalizado. Dois pagamentos iguais pro mesmo favorecido no mesmo dia (ex:
// dois boletos de R$50 por motivos diferentes) são legítimos e não podem
// virar "duplicata" um do outro — por isso a CONTAGEM de ocorrências (ver
// buildAlreadyLaunchedFlags) importa tanto quanto a chave em si. Valores
// baixos/redondos tornam essa coincidência bem mais provável.
function paymentLineKey(date: string, amount: number, payeeNameRaw: string): string {
  return `${date}|${amount.toFixed(2)}|${normalizeText(payeeNameRaw)}`;
}

// Marca como já lançada toda linha que já tem uma ocorrência correspondente
// salva antes (nota lançada via Documentos, linha de relação processada
// numa execução anterior, ou a mesma relação reenviada por engano) — sem
// descartar repetições legítimas dentro do próprio arquivo (a Nª ocorrência
// de uma chave só é duplicata da Nª ocorrência já existente no banco, não de
// qualquer ocorrência anterior).
function buildAlreadyLaunchedFlags(
  lines: ExtractedPaymentLine[],
  existingCounts: Map<string, number>
): boolean[] {
  const consumed = new Map<string, number>();
  return lines.map((line) => {
    const key = paymentLineKey(line.date, line.amount, line.payeeNameRaw);
    const already = existingCounts.get(key) ?? 0;
    const usedSoFar = consumed.get(key) ?? 0;
    consumed.set(key, usedSoFar + 1);
    return usedSoFar < already;
  });
}

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

    // Impressões digitais (data+valor+favorecido) já lançadas antes desta
    // execução — carregado 1x, só pras datas que aparecem nesta lista, pra
    // não varrer todo o histórico da empresa à toa.
    const existingCounts = await step.run("load-existing-payment-fingerprints", async () => {
      const dates = [...new Set(lines.map((l) => l.date))].map((d) => new Date(d));
      const rows = await prisma.transaction.findMany({
        where: { companyId: document.companyId, dueDate: { in: dates } },
        select: { dueDate: true, amount: true, supplier: { select: { name: true } } },
      });
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = paymentLineKey(
          row.dueDate.toISOString().slice(0, 10),
          Number(row.amount),
          row.supplier.name
        );
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()];
    });
    const alreadyLaunchedFlags = buildAlreadyLaunchedFlags(lines, new Map(existingCounts));

    let anyAwaitingInput = false;

    for (const [index, line] of lines.entries()) {
      await step.run(`persist-line-${line.lineNumber}`, async () => {
        if (alreadyLaunchedFlags[index]) {
          return; // essa combinação (favorecido+data+valor) já foi lançada antes
        }

        const lineDate = new Date(line.date);

        const supplier = await resolveSupplier({
          companyId: document.companyId,
          nameRaw: line.payeeNameRaw,
          taxId: line.taxId,
        });

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
