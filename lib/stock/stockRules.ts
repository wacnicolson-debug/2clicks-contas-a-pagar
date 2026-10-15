import { normalizeText } from "@/lib/utils/normalizeText";

export type StockKind = "TECIDO" | "AVIAMENTO" | "QUIMICO";

export const STOCK_KIND_LABEL: Record<StockKind, string> = {
  TECIDO: "Tecidos",
  AVIAMENTO: "Aviamentos",
  QUIMICO: "Produtos químicos",
};

/**
 * PRIMEIRA REGRA DO ESTOQUE: só entram notas de matéria-prima (tecidos e
 * aviamentos) e de produto químico. Qualquer outra categoria só aparece na
 * aba Compras. Decidido pela categoria do lançamento da nota.
 */
export function stockKindForCategory(categoryName: string | null | undefined): StockKind | null {
  const n = normalizeText(categoryName ?? "");
  if (n.includes("materia prima") && n.includes("tecido")) return "TECIDO";
  if (n.includes("materia prima") && n.includes("aviamento")) return "AVIAMENTO";
  if (n.includes("produto") && n.includes("quimico")) return "QUIMICO";
  return null;
}
