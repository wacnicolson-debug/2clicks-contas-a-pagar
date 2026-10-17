import { normalizeText } from "@/lib/utils/normalizeText";

// Empresas do grupo que usam o mesmo cadastro: a observação do lançamento diz de
// qual delas é o gasto ("mrc", "santa luzia"...). Sem nenhuma dessas marcas = GLM.
export const COST_GROUPS = [
  { key: "glm", label: "GLM", hint: "sem observação de outra empresa", match: null },
  { key: "mrc", label: "MRC", hint: "observação com MRC", match: /\bmrc\b/ },
  { key: "santa-luzia", label: "Santa Luzia", hint: "observação com Santa Luzia", match: /santa\s*luzia/ },
  { key: "maac", label: "MAAC", hint: "observação com MAAC", match: /\bmaac\b/ },
  { key: "waac", label: "WAAC", hint: "observação com WAAC", match: /\bwaac\b/ },
] as const;

export type CostGroupKey = (typeof COST_GROUPS)[number]["key"];

export function costGroupOf(description: string | null | undefined): CostGroupKey {
  const text = normalizeText(description ?? "");
  for (const g of COST_GROUPS) {
    if (g.match && g.match.test(text)) return g.key;
  }
  return "glm";
}

export function costGroupLabel(key: string): string {
  return COST_GROUPS.find((g) => g.key === key)?.label ?? key;
}

/** Categorias que abrem primeiro numa tela de somas por empresa (GLM / MRC / Santa Luzia...). */
export function categoryOpensByCompany(categoryName: string): boolean {
  const n = normalizeText(categoryName);
  return n.includes("mao de obra") || n.includes("imposto") || n.includes("energia") || n === "agua" || n.startsWith("agua ");
}
