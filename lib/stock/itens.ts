import { prisma } from "@/lib/db/prisma";
import { normalizeText } from "@/lib/utils/normalizeText";
import type { PurchaseItem } from "@/lib/ai/extractPurchaseItems";
import { STOCK_KIND_LABEL, type StockKind } from "./stockRules";

type Line = {
  kind: StockKind;
  name: string;
  generic: boolean;
  unit: string;
  date: Date;
  supplier: string;
  qty: number | null;
  unitPrice: number | null;
  total: number | null;
};

function brDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Nomes padrão de item já usados nesta empresa (pra IA reaproveitar em vez de criar outro). */
export async function knownItemNamesFor(companyId: string, kind: StockKind): Promise<string[]> {
  const notes = await prisma.purchaseNote.findMany({
    where: { companyId, stockKind: kind, itemsStatus: "DONE" },
    select: { items: true },
  });
  const names = new Map<string, string>();
  for (const n of notes) {
    for (const it of (Array.isArray(n.items) ? n.items : []) as unknown as PurchaseItem[]) {
      const name = it.itemName?.trim();
      if (name && !names.has(normalizeText(name))) names.set(normalizeText(name), name);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, "pt-BR")).slice(0, 400);
}

/**
 * Uma linha por item padrão (e unidade): última compra, preço anterior,
 * variação e estatísticas dos últimos 3 meses (contados até hoje).
 * Linhas "genéricas" (só o tipo: Zíper, Botão...) ficam marcadas.
 */
export async function buildItemRows(companyId: string, now = new Date()): Promise<(string | number)[][]> {
  const notes = await prisma.purchaseNote.findMany({
    where: { companyId, headerStatus: "DONE", itemsStatus: "DONE", stockKind: { not: null } },
    include: { supplier: { select: { name: true } } },
  });
  const groups = new Map<string, Line[]>();
  for (const n of notes) {
    const date = n.issueDate ?? n.monthDate;
    for (const it of (Array.isArray(n.items) ? n.items : []) as unknown as PurchaseItem[]) {
      const name = (it.itemName || it.description || "").trim();
      if (!name) continue;
      const qty = typeof it.quantity === "number" ? it.quantity : null;
      const total = typeof it.totalPrice === "number" ? it.totalPrice : null;
      let unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : null;
      if (unitPrice === null && qty && total !== null) unitPrice = total / qty;
      const unit = (it.unit ?? "").trim();
      const line: Line = { kind: n.stockKind as StockKind, name, generic: it.generic === true, unit, date, supplier: n.supplier.name, qty, unitPrice, total };
      const key = `${line.kind}|${normalizeText(name)}|${normalizeText(unit)}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
  }

  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate()));
  const kindOrder: Record<string, number> = { TECIDO: 0, AVIAMENTO: 1, QUIMICO: 2 };
  const out = [...groups.values()]
    .map((lines) => {
      lines.sort((a, b) => a.date.getTime() - b.date.getTime());
      const last = lines[lines.length - 1];
      const prev = lines.length > 1 ? lines[lines.length - 2] : null;
      const win = lines.filter((l) => l.date >= since);
      const priced = win.filter((l) => l.qty && l.total !== null);
      const sumQty = priced.reduce((s, l) => s + (l.qty ?? 0), 0);
      const sumTotal = priced.reduce((s, l) => s + (l.total ?? 0), 0);
      const prices = win.map((l) => l.unitPrice).filter((p): p is number => p !== null);
      const variation = prev && prev.unitPrice && last.unitPrice !== null ? (last.unitPrice - prev.unitPrice) / prev.unitPrice : null;
      return {
        kind: last.kind,
        name: last.name,
        row: [
          last.name,
          STOCK_KIND_LABEL[last.kind],
          last.unit,
          last.generic ? "genérico" : "",
          brDate(last.date),
          last.supplier,
          last.qty ?? "",
          last.unitPrice !== null ? round(last.unitPrice, 4) : "",
          prev?.unitPrice != null ? round(prev.unitPrice, 4) : "",
          prev ? prev.supplier : "",
          variation !== null ? round(variation, 4) : "",
          sumQty > 0 ? round(sumTotal / sumQty, 4) : prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length, 4) : "",
          win.length ? round(win.reduce((s, l) => s + (l.qty ?? 0), 0), 3) : "",
          win.length ? round(win.reduce((s, l) => s + (l.total ?? 0), 0)) : "",
          prices.length ? round(Math.min(...prices), 4) : "",
          prices.length ? round(Math.max(...prices), 4) : "",
          lines.length,
        ] as (string | number)[],
      };
    })
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name, "pt-BR"));
  return out.map((o) => o.row);
}
