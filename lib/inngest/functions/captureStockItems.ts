import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import { extractPurchaseItems } from "@/lib/ai/extractPurchaseItems";
import { applyIssueDate, writeEstoqueRows } from "@/lib/stock/purchases";
import type { StockKind } from "@/lib/stock/stockRules";

/**
 * Lê os itens de uma nota de estoque (matéria-prima ou produto químico) e
 * grava na aba Estoque. Roda depois do lançamento já estar na planilha de
 * contas a pagar — nunca atrasa nem derruba o lançamento.
 */
export const captureStockItems = inngest.createFunction(
  { id: "capture-stock-items", retries: 2, triggers: [{ event: "purchase/items" }] },
  async ({ event, step }) => {
    const { purchaseNoteId } = event.data as { purchaseNoteId: string };

    const note = await step.run("load-note", () =>
      prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId } })
    );
    if (!note || !note.stockKind) return { skipped: true };
    if (note.headerStatus !== "DONE") return { skipped: "cabeçalho fiscal ainda não lido" };
    if (note.itemsStatus === "DONE") return { skipped: "já lida" };

    const result = await step.run("read-items", async () => {
      try {
        const page = await prisma.documentPage.findUniqueOrThrow({ where: { id: note.documentPageId } });
        const document = await prisma.document.findUniqueOrThrow({ where: { id: note.documentId } });
        // A nota pode continuar em folhas seguintes ("folha 2/2"), que o
        // lançamento guarda como cópia — os itens podem estar nelas.
        const siblings = await prisma.documentPage.findMany({ where: { documentId: note.documentId } });
        const continuation = siblings
          .filter((p) => (p.rawExtraction as { duplicateOfPageNumber?: number | null }).duplicateOfPageNumber === page.pageNumber)
          .map((p) => p.pageNumber);
        const buffer = await downloadDocumentFile(document.storagePath);
        return await extractPurchaseItems({
          fileBase64: buffer.toString("base64"),
          mimeType: document.mimeType,
          pageNumbers: [page.pageNumber, ...continuation].sort((a, b) => a - b),
          kind: note.stockKind as StockKind,
        });
      } catch (err) {
        await prisma.purchaseNote.update({ where: { id: note.id }, data: { itemsStatus: "ERROR" } });
        if (err instanceof Error && /se recusou/.test(err.message)) throw new NonRetriableError(err.message);
        throw err;
      }
    });

    await step.run("save-items", () =>
      prisma.purchaseNote.update({
        where: { id: note.id },
        data: {
          items: result.items as unknown as object,
          itemsStatus: "DONE",
          remark: [note.remark, result.remark].filter(Boolean).join("; ") || null,
        },
      })
    );

    // Nota sem data de emissão no lançamento (leitura antiga): usa a que a
    // leitura dos itens achou, pro mês ficar certo nas duas abas.
    if (!note.issueDate && result.issueDate) {
      await step.run("apply-issue-date", () => applyIssueDate(note.id, result.issueDate!));
    }

    await step.run("write-sheet", () => writeEstoqueRows(note.id));
    return { items: result.items.length };
  }
);
