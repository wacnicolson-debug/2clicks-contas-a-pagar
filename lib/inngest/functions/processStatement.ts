import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import { extractStatementLines, ExtractedStatementLine } from "@/lib/ai/extractStatement";
import { resolveSupplier, needsOnboardingQuestions } from "@/lib/suppliers/resolveSupplier";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";
import { normalizeText } from "@/lib/utils/normalizeText";

// Chave de "impressão digital" de uma linha de extrato: data+valor+descrição
// normalizada. Duas linhas iguais no mesmo dia (ex: dois Ubers idênticos) são
// legítimas e não podem virar "duplicata" uma da outra — por isso a
// contagem de ocorrências (ver buildDuplicateFlags) importa tanto quanto a chave.
function statementLineKey(date: string, amount: number, description: string): string {
  return `${date}|${amount.toFixed(2)}|${normalizeText(description)}`;
}

// Marca como duplicata toda linha do arquivo que já tem uma ocorrência
// correspondente salva em execuções anteriores (mesmo extrato reenviado, ou
// reprocessado após falha parcial) — sem descartar repetições legítimas
// dentro do próprio arquivo (a Nª ocorrência de uma chave só é duplicata da
// Nª ocorrência já existente no banco, não de qualquer ocorrência anterior).
function buildDuplicateFlags(
  lines: ExtractedStatementLine[],
  existingCounts: Map<string, number>
): boolean[] {
  const consumed = new Map<string, number>();
  return lines.map((line) => {
    const key = statementLineKey(line.date, line.amount, line.description);
    const already = existingCounts.get(key) ?? 0;
    const usedSoFar = consumed.get(key) ?? 0;
    consumed.set(key, usedSoFar + 1);
    return usedSoFar < already;
  });
}

/**
 * Processa 1 extrato bancário enviado ("Adicionar Extrato"). Reaproveita o
 * mesmo pipeline das notas (Document/DocumentPage/perguntas/answer) — a
 * diferença é que aqui a gente primeiro tenta CASAR cada linha com um
 * Transaction já existente (mesma data+valor+direção) antes de tratar como
 * cobrança nova. Ver plano em polished-watching-rivest.md.
 */
export const processStatement = inngest.createFunction(
  { id: "process-statement", retries: 3, triggers: [{ event: "statement/uploaded" }] },
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
        return extractStatementLines({
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
        err instanceof Error ? err.message : "Falha ao ler o extrato."
      );
    }

    // Transactions já casados com alguma linha (nesta execução ou em execuções
    // anteriores) não podem ser casados de novo com outra linha igual.
    const alreadyMatched = await step.run("load-already-matched", async () => {
      const rows = await prisma.bankStatementLine.findMany({
        where: { companyId: document.companyId, matchedTransactionId: { not: null } },
        select: { matchedTransactionId: true },
      });
      return rows.map((r) => r.matchedTransactionId!);
    });
    const usedTransactionIds = new Set(alreadyMatched);

    // Linhas de extrato já salvas antes (qualquer status), contadas por
    // impressão digital — usado pra detectar reenvio do mesmo extrato.
    const existingLineCounts = await step.run("load-existing-line-fingerprints", async () => {
      const rows = await prisma.bankStatementLine.findMany({
        where: { companyId: document.companyId },
        select: { date: true, amount: true, rawDescription: true },
      });
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = statementLineKey(
          row.date.toISOString().slice(0, 10),
          Number(row.amount),
          row.rawDescription
        );
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()];
    });
    const duplicateFlags = buildDuplicateFlags(lines, new Map(existingLineCounts));

    let anyAwaitingInput = false;

    for (const [index, line] of lines.entries()) {
      await step.run(`persist-line-${line.lineNumber}`, async () => {
        if (duplicateFlags[index]) {
          return; // já existe uma linha igual salva antes — extrato reenviado, ignora
        }

        const lineDate = new Date(line.date);
        const kind = line.direction === "ENTRADA" ? "RECEIVABLE" : "PAYABLE";

        // Casa por valor+direção exatos, mas com TOLERÂNCIA de alguns dias na
        // data — um pagamento agendado pode ter sido lançado com a data do
        // agendamento em vez da data real do débito (que é o que aparece
        // aqui, no extrato), então exigir data idêntica deixava passar
        // casamentos válidos. Valor é sempre exato (não tem por que variar);
        // entre candidatos na janela, fica com o de data mais próxima.
        const DATE_TOLERANCE_DAYS = 5;
        const dayMs = 24 * 60 * 60 * 1000;
        const candidates = await prisma.transaction.findMany({
          where: {
            companyId: document.companyId,
            kind,
            amount: line.amount,
            dueDate: {
              gte: new Date(lineDate.getTime() - DATE_TOLERANCE_DAYS * dayMs),
              lte: new Date(lineDate.getTime() + DATE_TOLERANCE_DAYS * dayMs),
            },
            id: { notIn: [...usedTransactionIds] },
          },
        });
        const match = candidates.sort((a, b) => {
          const diffA = Math.abs(a.dueDate.getTime() - lineDate.getTime());
          const diffB = Math.abs(b.dueDate.getTime() - lineDate.getTime());
          return diffA !== diffB ? diffA - diffB : a.createdAt.getTime() - b.createdAt.getTime();
        })[0];

        if (match) {
          usedTransactionIds.add(match.id);
          await prisma.bankStatementLine.create({
            data: {
              companyId: document.companyId,
              documentId: document.id,
              rawDescription: line.description,
              amount: line.amount,
              date: lineDate,
              matchedTransactionId: match.id,
              status: "MATCHED",
            },
          });
          return; // bateu com uma nota já lançada — só marca conferido, não mexe em mais nada
        }

        // Não bateu com nada — trata como cobrança nova, igual ao fluxo de
        // notas (mesmo resolveSupplier, mesma automação pra fornecedor já
        // conhecido). Diferença: já é sempre PAGO (o dinheiro já se moveu).
        const supplier = await resolveSupplier({
          companyId: document.companyId,
          nameRaw: line.description,
          taxId: null,
        });

        const needsInput = needsOnboardingQuestions(supplier) || supplier.alwaysAskCategory;

        const docPage = await prisma.documentPage.create({
          data: {
            documentId: document.id,
            pageNumber: line.lineNumber,
            rawExtraction: {
              pageNumber: line.lineNumber,
              supplierNameRaw: line.description,
              taxId: null,
              installments: [{ amount: line.amount, dueDate: line.date }],
              confidence: 1,
              notes: "Linha de extrato bancário sem nota correspondente.",
              duplicateOfPageNumber: null,
              // Direção do extrato já diz se é dinheiro saindo (fornecedor) ou
              // entrando (cliente) — evita nascer sempre em "Fornecedor" e
              // obrigar o usuário a corrigir toda entrada manualmente.
              knownKind: kind === "RECEIVABLE" ? "CLIENTE" : "FORNECEDOR",
            },
            supplierId: supplier.id,
            confidence: 1,
            status: needsInput ? "AWAITING_USER_INPUT" : "DONE",
          },
        });

        if (needsInput) {
          anyAwaitingInput = true;
          await prisma.bankStatementLine.create({
            data: {
              companyId: document.companyId,
              documentId: document.id,
              documentPageId: docPage.id,
              rawDescription: line.description,
              amount: line.amount,
              date: lineDate,
              status: "ORPHAN",
            },
          });
          return; // aguarda o usuário responder na tela de perguntas
        }

        // Fornecedor já conhecido: lança automático, sempre como Pago.
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
            paymentMethod: supplier.paymentMethod ?? undefined,
            pixKey: supplier.pixKey,
            categoryId: supplier.defaultCategoryId,
            paid: true,
            createdByUserId: document.uploadedById,
          },
        });
        await syncTransactionToSheet(transaction.id);

        await prisma.bankStatementLine.create({
          data: {
            companyId: document.companyId,
            documentId: document.id,
            documentPageId: docPage.id,
            rawDescription: line.description,
            amount: line.amount,
            date: lineDate,
            matchedTransactionId: transaction.id,
            status: "CLASSIFIED",
          },
        });
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
