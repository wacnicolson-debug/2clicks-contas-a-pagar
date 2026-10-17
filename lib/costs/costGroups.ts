import { normalizeText } from "@/lib/utils/normalizeText";

// A observação do lançamento separa o gasto dentro de algumas categorias.
// "empresa": de qual empresa do grupo é o gasto ("mrc", "santa luzia"...). Sem nenhuma
//            dessas marcas = GLM.
// "lenha":   Produtos químicos separa Lenha do restante (só a GLM compra produto químico).
export type GroupMode = "empresa" | "lenha";

// Desligado até o usuário terminar de marcar "lenha" nas observações (pediu pra esperar).
const LENHA_ENABLED = false;

type GroupDef = { key: string; label: string; hint: string; match: RegExp | null };

const EMPRESA_GROUPS: GroupDef[] = [
  { key: "glm", label: "GLM", hint: "sem observação de outra empresa", match: null },
  { key: "mrc", label: "MRC", hint: "observação com MRC", match: /\bmrc\b/ },
  { key: "santa-luzia", label: "Santa Luzia", hint: "observação com Santa Luzia", match: /santa\s*luzia/ },
  { key: "maac", label: "MAAC", hint: "observação com MAAC", match: /\bmaac\b/ },
  { key: "waac", label: "WAAC", hint: "observação com WAAC", match: /\bwaac\b/ },
];

const LENHA_GROUPS: GroupDef[] = [
  { key: "lenha", label: "Lenha", hint: "observação com lenha", match: /\blenha\b/ },
  { key: "restante", label: "Restante", hint: "tudo que não é lenha", match: null },
];

export function groupsFor(mode: GroupMode): GroupDef[] {
  return mode === "lenha" ? LENHA_GROUPS : EMPRESA_GROUPS;
}

/** Em qual grupo o lançamento cai, pela observação. */
export function costGroupOf(mode: GroupMode, description: string | null | undefined): string {
  const groups = groupsFor(mode);
  const text = normalizeText(description ?? "");
  for (const g of groups) {
    if (g.match && g.match.test(text)) return g.key;
  }
  return groups.find((g) => g.match === null)!.key;
}

export function costGroupLabel(mode: GroupMode, key: string): string {
  return groupsFor(mode).find((g) => g.key === key)?.label ?? key;
}

/** Que tipo de separação a categoria tem (null = abre direto na lista item a item). */
export function groupModeFor(categoryName: string): GroupMode | null {
  const n = normalizeText(categoryName);
  if (LENHA_ENABLED && n.includes("quimic")) return "lenha";
  if (n.includes("mao de obra") || n.includes("imposto") || n.includes("energia") || n === "agua" || n.startsWith("agua ")) {
    return "empresa";
  }
  return null;
}
