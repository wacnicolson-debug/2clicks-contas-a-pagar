import { normalizeText } from "@/lib/utils/normalizeText";

// Dinheiro que entra via saque (categoria CAIXA) é usado quase todo pra pagar mão de obra.
// Na Distribuição de custos o CAIXA só aparece como informação (fora da soma): 80% entra em
// "Mão de obra" e 20% em "Outros". Os lançamentos em si não mudam.
export const SAQUE_LABOR_PERCENT = 80;

export type SaqueRole = "saque" | "labor" | "others";

export function saqueRoleOf(categoryName: string): SaqueRole | null {
  const n = normalizeText(categoryName).trim();
  if (n === "caixa") return "saque";
  if (n === "mao de obra") return "labor";
  if (n === "outros") return "others";
  return null;
}

/** Divide um valor de saque: o resto vai pra "Outros", então as duas partes sempre somam o valor original. */
export function splitSaque(amount: number): { labor: number; others: number } {
  const labor = Math.round(amount * SAQUE_LABOR_PERCENT) / 100;
  return { labor, others: Math.round((amount - labor) * 100) / 100 };
}
