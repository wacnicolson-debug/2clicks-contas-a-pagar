import { normalizeText } from "@/lib/utils/normalizeText";
import automaticos from "./data/lancAutomaticosCompra.json";
import contas from "./data/contasFornecedores.json";

// Dados exportados do Alterdata da GLM (plano de contas 00012, "Relatório
// completo" dos lançamentos automáticos): um lançamento automático de compra por
// fornecedor (débito 0957, crédito na conta do fornecedor) e as contas de
// fornecedor do plano. Precisam ser reexportados quando o contador criar
// fornecedores ou automáticos novos.

const STOPWORDS = new Set([
  "ltda", "me", "epp", "eireli", "s", "a", "sa", "de", "do", "da", "dos", "das", "e", "ind", "com", "industria", "comercio", "cia", "e", "em",
]);

function tokens(s: string): string[] {
  return normalizeText(s)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
}

/** "Santista Compra- merc.\produtos" → "Santista"; "Compras Damenny" → "Damenny". */
function autoPrefix(descricao: string): string {
  return descricao
    .replace(/\s*compras?\s*-?\s*merc.*$/i, "")
    .replace(/^compras?\s+/i, "")
    .trim();
}

const AUTO = (automaticos as { codigo: string; descricao: string }[]).map((a) => ({
  codigo: a.codigo,
  prefix: tokens(autoPrefix(a.descricao)),
  bruto: autoPrefix(a.descricao),
}));

const CONTAS = (contas as { nome: string; conta: string }[]).map((c) => ({ conta: c.conta, nome: c.nome, k: tokens(c.nome).join(" ") }));

/** Código do lançamento automático de compra do fornecedor, se o contador já criou um. */
function automaticoDoFornecedor(supplierName: string): { codigo?: string; talvez?: string[] } {
  const t = tokens(supplierName);
  const joined = t.join(" ");
  const hits = AUTO.filter((a) => {
    if (a.prefix.length === 0) return false;
    const p = a.prefix.join(" ");
    if (p.length < 5 && a.prefix.length < 2) return joined === p || joined.startsWith(p + " "); // siglas curtas: só no início do nome
    return a.prefix.every((w) => t.includes(w));
  });
  if (hits.length === 1) return { codigo: hits[0].codigo };
  if (hits.length > 1) return { talvez: hits.map((h) => h.codigo) };
  return {};
}

/** Conta(s) contábil(eis) do fornecedor no plano (pelo nome). O plano tem contas repetidas pro mesmo fornecedor, então lista até 3. */
function contaDoFornecedor(supplierName: string): string | null {
  const k = tokens(supplierName).join(" ");
  if (!k) return null;
  const exact = CONTAS.filter((c) => c.k === k);
  const hits = exact.length ? exact : CONTAS.filter((c) => k.length >= 8 && c.k.length >= 8 && (c.k.startsWith(k + " ") || k.startsWith(c.k + " ")));
  const distinct = [...new Set(hits.map((h) => h.conta))];
  return distinct.length > 0 && distinct.length <= 3 ? distinct.join(" / ") : null;
}

/**
 * O que a coluna "Lanç. automático" mostra: o código do automático do
 * fornecedor, ou "CRIAR" (com a conta dele, se achada) quando ainda não existe.
 */
export function lancamentoAutomaticoParaFornecedor(supplierName: string): string {
  const a = automaticoDoFornecedor(supplierName);
  if (a.codigo) return a.codigo;
  if (a.talvez) return `CONFERIR: ${a.talvez.join(" ou ")}`;
  const conta = contaDoFornecedor(supplierName);
  return conta ? `CRIAR (conta ${conta})` : "CRIAR (conta ?)";
}
