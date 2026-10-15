import { prisma } from "@/lib/db/prisma";
import { normalizeText } from "@/lib/utils/normalizeText";
import type { PurchaseItem } from "@/lib/ai/extractPurchaseItems";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";
import { STOCK_KIND_LABEL, type StockKind } from "./stockRules";

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

type Line = {
  key: string; // tipo | item padrão | unidade
  date: Date;
  order: number; // desempate: ordem de chegada da nota e posição do item
  monthLabel: string;
  supplier: string;
  noteNumber: string;
  kind: StockKind;
  item: PurchaseItem;
  qty: number | null;
  unitPrice: number | null;
  total: number | null;
  remark: string;
  first: boolean; // primeira linha da nota (leva a observação)
};

/**
 * Uma linha por item de cada nota (5 itens = 5 linhas), em ordem de data.
 * Em cada linha: preço anterior do mesmo item (mesma unidade), variação e a
 * média ponderada das compras dos 3 meses anteriores a ela. Só aparecem as linhas
 * do ano da planilha (o histórico de preço usa todos os anos). Cada mês começa
 * com uma faixa de título com o total do mês (índices em `bands`).
 */
export async function buildEstoqueRows(
  companyId: string,
  year: number
): Promise<{ rows: (string | number)[][]; bands: number[] }> {
  const notes = await prisma.purchaseNote.findMany({
    where: { companyId, headerStatus: "DONE", itemsStatus: "DONE", stockKind: { not: null } },
    include: { supplier: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const lines: Line[] = [];
  let order = 0;
  for (const n of notes) {
    const date = n.issueDate ?? n.monthDate;
    const items = (Array.isArray(n.items) ? n.items : []) as unknown as PurchaseItem[];
    const kind = n.stockKind as StockKind;
    const base = {
      date,
      monthLabel: MONTHS[date.getUTCMonth()],
      supplier: n.supplier.name,
      noteNumber: n.noteNumber ?? "",
      kind,
      remark: n.remark ?? "",
    };
    if (items.length === 0) {
      // não conseguiu ler os itens: avisa na própria linha pra conferir a nota
      lines.push({ ...base, key: `x${order}`, order: order++, item: { description: "NÃO FOI POSSÍVEL LER OS ITENS — conferir a nota", itemName: "", generic: false, code: null, quantity: null, unit: null, unitPrice: null, totalPrice: null }, qty: null, unitPrice: null, total: null, first: true });
      continue;
    }
    items.forEach((it, i) => {
      const qty = typeof it.quantity === "number" ? it.quantity : null;
      const total = typeof it.totalPrice === "number" ? it.totalPrice : null;
      let unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : null;
      if (unitPrice === null && qty && total !== null) unitPrice = total / qty;
      const name = (it.itemName || it.description || "").trim();
      lines.push({
        ...base,
        key: `${kind}|${normalizeText(name)}|${normalizeText(it.unit ?? "")}`,
        order: order++,
        item: it,
        qty,
        unitPrice,
        total,
        first: i === 0,
      });
    });
  }

  lines.sort((a, b) => a.date.getTime() - b.date.getTime() || a.order - b.order);

  const rows: (string | number)[][] = [];
  const bands: number[] = [];
  let currentMonth = -1;
  const monthTotals = new Map<number, number>();
  for (const l of lines) {
    if (l.date.getUTCFullYear() === year) monthTotals.set(l.date.getUTCMonth(), (monthTotals.get(l.date.getUTCMonth()) ?? 0) + (l.total ?? 0));
  }
  const history = new Map<string, Line[]>();
  for (const l of lines) {
    const before = history.get(l.key) ?? [];
    const prev = before.length ? before[before.length - 1] : null;
    const since = new Date(Date.UTC(l.date.getUTCFullYear(), l.date.getUTCMonth() - 3, l.date.getUTCDate()));
    const win = before.filter((p) => p.date >= since);
    const priced = win.filter((p) => p.qty && p.total !== null);
    const sumQty = priced.reduce((s, p) => s + (p.qty ?? 0), 0);
    const sumTotal = priced.reduce((s, p) => s + (p.total ?? 0), 0);
    const prices = win.map((p) => p.unitPrice).filter((p): p is number => p !== null);
    const avg = sumQty > 0 ? sumTotal / sumQty : prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const variation = prev?.unitPrice && l.unitPrice !== null ? (l.unitPrice - prev.unitPrice) / prev.unitPrice : null;

    if (l.date.getUTCFullYear() !== year) {
      if (!l.key.startsWith("x")) history.set(l.key, [...before, l]);
      continue;
    }
    const month = l.date.getUTCMonth();
    if (month !== currentMonth) {
      if (rows.length > 0) rows.push(new Array(16).fill("")); // linha em branco entre os meses
      bands.push(rows.length);
      // apóstrofo: força texto (senão a planilha entende "AGOSTO 2026" como data)
      rows.push([`'${MONTHS[month].toUpperCase()} ${year}`, "", "", "", "", "", "", "", "", "", "Total do mês", round(monthTotals.get(month) ?? 0), "", "", "", ""]);
      currentMonth = month;
    }
    const it = l.item;
    rows.push([
      l.monthLabel,
      brDate(l.date),
      l.supplier,
      l.noteNumber,
      STOCK_KIND_LABEL[l.kind],
      it.itemName || "",
      it.code ? `${it.description} (cód. ${it.code})` : it.description,
      it.generic ? "genérico" : "",
      l.qty ?? "",
      it.unit ?? "",
      l.unitPrice !== null ? round(l.unitPrice, 4) : "",
      l.total !== null ? round(l.total) : "",
      prev?.unitPrice != null ? round(prev.unitPrice, 4) : "",
      variation !== null ? round(variation, 4) : "",
      avg !== null ? round(avg, 4) : "",
      l.first ? l.remark : "",
    ]);
    if (!l.key.startsWith("x")) history.set(l.key, [...before, l]);
  }
  return { rows, bands };
}
