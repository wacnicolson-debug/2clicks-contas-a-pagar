import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";
import { parseBrDate } from "./brDate";
import type { StockKind } from "@/lib/stock/stockRules";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type PurchaseItem = {
  description: string;
  itemName: string; // nome padrão do item (reaproveita um já conhecido) ou o tipo genérico (Zíper, Botão, Linha...)
  generic: boolean; // true = só deu pra saber o tipo, não o modelo
  code: string | null;
  quantity: number | null;
  unit: string | null; // m, kg, un, cx, rolo, cone, l, par, jg, pct, sc, gl, outro
  unitPrice: number | null;
  totalPrice: number | null;
};

export type PurchaseItemsResult = {
  items: PurchaseItem[];
  issueDate: string | null; // data de emissão (AAAA-MM-DD), convertida em código
  productsTotal: number | null; // "valor total dos produtos" impresso na nota
  noteTotal: number | null; // "valor total da nota" impresso na nota
  remark: string | null; // divergência encontrada na própria leitura
  confidence: number;
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "issueDateText", "productsTotal", "noteTotal", "confidence", "remarks"],
  properties: {
    items: {
      type: "array",
      description: "TODOS os itens (produtos) da nota, na ordem em que aparecem — não pule nenhum.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "itemName", "generic", "code", "quantity", "unit", "unitPrice", "totalPrice"],
        properties: {
          description: { type: "string", description: "Descrição do item exatamente como impressa na nota (cor, largura, composição, referência etc. fazem parte da descrição)." },
          itemName: {
            type: "string",
            description:
              "Nome PADRÃO do item, curto e sem código de nota, pra controle de estoque (ex: 'Tecido Luky Mescla Cinza', 'Zíper de aço N11 preto', 'Sal moído iodado'). Se for o mesmo produto de um item da lista de itens conhecidos (mesmo modelo/cor), copie o nome conhecido EXATAMENTE. Se só dá pra saber o TIPO e não o modelo (descrição vaga como 'ZIPER', 'BOTAO', 'LINHA'), use só o tipo genérico: 'Zíper', 'Botão', 'Linha', 'Etiqueta', 'Elástico', 'Fita' etc.",
          },
          generic: { type: "boolean", description: "true se itemName é só o tipo genérico (modelo não identificável); false se é um item específico identificável." },
          code: { type: ["string", "null"], description: "Código do produto na nota, se houver." },
          quantity: { type: ["number", "null"], description: "Quantidade como número (ponto decimal), na unidade da própria nota." },
          unit: {
            type: ["string", "null"],
            description: "Unidade normalizada: m (metro/MT/MTS), kg, un (UN/UNID/PÇ/PC/PEÇA), milheiro (MI/MIL/MILH), cx, rolo, cone, l (litro/LT), par, jg, pct, sc (saco), gl (galão), ou outro texto curto se for diferente.",
          },
          unitPrice: { type: ["number", "null"], description: "Valor unitário em reais, como impresso (pode ter até 4 casas)." },
          totalPrice: { type: ["number", "null"], description: "Valor total do item, em reais, como impresso." },
        },
      },
    },
    issueDateText: { type: ["string", "null"], description: "DATA DE EMISSÃO da nota exatamente como impressa (ex: 09/10/2026). NÃO é a data de vencimento nem a de saída. null se não estiver legível." },
    productsTotal: { type: ["number", "null"], description: "Campo 'valor total dos produtos' da nota, ou null." },
    noteTotal: { type: ["number", "null"], description: "Campo 'valor total da nota' (com frete, IPI, impostos), ou null." },
    confidence: { type: "number", description: "Confiança da leitura, de 0 a 1." },
    remarks: { type: ["string", "null"], description: "Qualquer dúvida de leitura (ex: item ilegível, soma que não bate). null se estiver tudo certo." },
  },
} as const;

const KIND_HINT: Record<StockKind, string> = {
  TECIDO:
    "Esta nota é de TECIDO. Quantidade normalmente em metros (m) ou quilos (kg) — respeite a unidade da nota. A descrição costuma ter tipo/composição, cor e largura; mantenha tudo na descrição.",
  AVIAMENTO:
    "Esta nota é de AVIAMENTOS (linhas, zíperes, botões, etiquetas, elásticos, fitas etc.). Quantidade em un, cx, rolo, cone, pct, par, m ou kg — respeite a unidade da nota. Mantenha tamanho/cor/referência na descrição.",
  QUIMICO:
    "Esta nota é de PRODUTO QUÍMICO. Quantidade normalmente em kg ou litros (l), às vezes em galão/tambor (use 'outro' e escreva na descrição) — respeite a unidade da nota.",
};

function buildSystemPrompt(kind: StockKind, knownItems: string[]): string {
  const known = knownItems.length
    ? `\n\nItens JÁ CONHECIDOS desta empresa (use o nome exatamente igual quando for o mesmo produto):\n${knownItems.map((n) => `- ${n}`).join("\n")}`
    : "";
  return `Você lê os ITENS de uma nota fiscal (DANFE/NF-e) ou nota de compra brasileira, pra alimentar o controle de estoque de uma confecção. ${KIND_HINT[kind]}

Regras:
- Leia SOMENTE a(s) página(s) indicadas na mensagem (a nota e, quando houver, as folhas de continuação dela). Não misture com outras notas do mesmo arquivo.
- Liste TODOS os itens da tabela "Dados dos produtos/serviços" (ou equivalente), na ordem, um por linha da nota. Não some, não resuma, não junte itens parecidos.
- Copie descrição, quantidade, unidade, valor unitário e valor total EXATAMENTE como impressos. Números em formato brasileiro (1.234,56) viram número com ponto decimal (1234.56). Nunca invente: se um campo não estiver legível, devolva null.
- Ignore faturas/duplicatas (parcelas), dados de transporte e totais de impostos — isso não é item.
- Confira: a soma dos valores totais dos itens deve bater com o "valor total dos produtos". Se não bater, releia as linhas antes de responder; se ainda não bater, explique em "remarks".
- Datas e valores de pagamento NÃO fazem parte desta leitura.
- Para cada item, dê um itemName padrão: o mesmo produto sempre com o mesmo nome (mesmo modelo e cor = mesmo nome, mesmo escrito diferente na nota). Tecido: nome do tecido + cor (ex: 'Tecido Luky Mescla Cinza'). Aviamento: tipo + modelo/especificação principal (ex: 'Zíper de aço N11 preto'). Se a descrição não deixa claro o modelo, não invente: use só o tipo ('Zíper') e marque generic=true. Nunca misture dois produtos diferentes no mesmo nome.${known}`;
}

const UNIT_ALIASES: Record<string, string> = {
  mi: "milheiro", mil: "milheiro", milh: "milheiro", millheiro: "milheiro",
  mt: "m", mts: "m", metro: "m", metros: "m",
  un: "un", und: "un", unid: "un", pc: "un", pç: "un", pca: "un", peca: "un", peça: "un",
  lt: "l", litro: "l", litros: "l", kgs: "kg", quilo: "kg",
};

/** Unidade em forma única (MI e MILHEIRO viram a mesma coisa), pra somar e comparar preços. */
function normalizeUnit(unit: string | null | undefined): string | null {
  const u = unit?.trim().toLowerCase().replace(/\./g, "");
  if (!u) return null;
  return UNIT_ALIASES[u] ?? u;
}

export async function extractPurchaseItems(params: {
  fileBase64: string;
  mimeType: string;
  pageNumbers: number[]; // a página da nota + continuações
  kind: StockKind;
  knownItems?: string[]; // nomes padrão já usados nesta empresa, pra não duplicar o item
}): Promise<PurchaseItemsResult> {
  const pagesText = params.pageNumbers.join(", ");
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: buildSystemPrompt(params.kind, params.knownItems ?? []),
    messages: [
      {
        role: "user",
        content: [
          buildFileContentBlock(params.fileBase64, params.mimeType),
          {
            type: "text",
            text: `Leia os itens da nota que está na(s) página(s) ${pagesText} deste arquivo, conforme instruído.`,
          },
        ],
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") throw new Error("A IA se recusou a ler os itens desta nota.");
  if (message.stop_reason === "max_tokens") throw new Error("A leitura dos itens ficou grande demais e foi cortada.");

  const text = message.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) throw new Error("A IA não retornou os itens desta nota.");

  const raw = JSON.parse(text) as {
    items: PurchaseItem[] | null;
    issueDateText: string | null;
    productsTotal: number | null;
    noteTotal: number | null;
    confidence: number;
    remarks: string | null;
  };
  const items = (raw.items ?? [])
    .filter((i) => i && typeof i.description === "string" && i.description.trim() !== "")
    .map((i) => ({
      description: i.description.trim(),
      itemName: (typeof i.itemName === "string" && i.itemName.trim()) || i.description.trim(),
      generic: i.generic === true,
      code: i.code?.trim() || null,
      quantity: Number.isFinite(i.quantity) ? i.quantity : null,
      unit: normalizeUnit(i.unit),
      unitPrice: Number.isFinite(i.unitPrice) ? i.unitPrice : null,
      totalPrice: Number.isFinite(i.totalPrice) ? i.totalPrice : null,
    }));

  // Conferência em código (não confia só na IA): soma dos itens x total dos produtos.
  let remark = raw.remarks?.trim() || null;
  const sum = items.reduce((s, i) => s + (i.totalPrice ?? 0), 0);
  if (raw.productsTotal && items.length > 0 && Math.abs(sum - raw.productsTotal) > 0.05 * Math.max(1, items.length)) {
    const diff = `soma dos itens R$ ${sum.toFixed(2)} ≠ total dos produtos R$ ${raw.productsTotal.toFixed(2)} — conferir`;
    remark = remark ? `${remark}; ${diff}` : diff;
  }

  return {
    items,
    issueDate: parseBrDate(raw.issueDateText),
    productsTotal: raw.productsTotal ?? null,
    noteTotal: raw.noteTotal ?? null,
    remark,
    confidence: raw.confidence,
  };
}
