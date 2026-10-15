import { inngest } from "@/lib/inngest/client";
import { NonRetriableError } from "inngest";
import { prisma } from "@/lib/db/prisma";
import { readPurchaseHeader, savePurchaseHeader } from "@/lib/stock/purchases";

/**
 * Lê o cabeçalho fiscal (CNPJ, CFOP, série, chave, impostos, data de emissão)
 * de uma nota já lançada e põe na aba do mês da planilha de Compras. Só notas
 * fiscais entram; se a nota tem itens de estoque, agenda a leitura dos itens.
 * Roda depois do lançamento — nunca atrasa nem derruba o lançamento.
 */
export const capturePurchaseHeader = inngest.createFunction(
  { id: "capture-purchase-header", retries: 2, triggers: [{ event: "purchase/header" }] },
  async ({ event, step }) => {
    const { purchaseNoteId } = event.data as { purchaseNoteId: string };

    const note = await step.run("load-note", () => prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId } }));
    if (!note) return { skipped: "nota não existe mais" };
    if (note.headerStatus === "DONE" || note.headerStatus === "SKIPPED") return { skipped: "já lida" };

    const header = await step.run("read-header", async () => {
      try {
        return await readPurchaseHeader(note.id);
      } catch (err) {
        if (err instanceof Error && /se recusou/.test(err.message)) throw new NonRetriableError(err.message);
        throw err;
      }
    });

    const saved = await step.run("save-and-write-sheet", () => savePurchaseHeader(note.id, header));
    if (saved.readItems) {
      await step.sendEvent("queue-items", { id: `purchase-items-${note.id}`, name: "purchase/items", data: { purchaseNoteId: note.id } });
    }
    return saved;
  }
);
