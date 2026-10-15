import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";
import { parseBrDate } from "./brDate";
import { isValidTaxId } from "@/lib/utils/taxId";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type PurchaseDocType = "NFE" | "NFSE" | "OUTRO";

export type PurchaseHeader = {
  docType: PurchaseDocType;
  issueDate: string | null; // AAAA-MM-DD, convertida em código
  supplierCnpj: string | null; // 14 dígitos, com dígito verificador conferido
  noteNumber: string | null;
  series: string | null;
  accessKey: string | null; // 44 dígitos, com dígito verificador conferido
  cfops: string[]; // 4 dígitos, sem repetir, na ordem em que aparecem
  productsTotal: number | null;
  freight: number | null;
  ipi: number | null;
  icmsBase: number | null;
  icmsValue: number | null;
  noteTotal: number | null;
  remark: string | null;
  confidence: number;
};

const num = { type: ["number", "null"] } as const;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "docType",
    "issueDateText",
    "supplierCnpj",
    "noteNumber",
    "series",
    "accessKey",
    "cfops",
    "productsTotal",
    "freight",
    "insurance",
    "otherExpenses",
    "discount",
    "ipi",
    "icmsStValue",
    "icmsBase",
    "icmsValue",
    "noteTotal",
    "confidence",
    "remarks",
  ],
  properties: {
    docType: {
      type: "string",
      enum: ["NFE", "NFSE", "OUTRO"],
      description:
        "NFE = nota fiscal de produtos (DANFE / NF-e modelo 55, ou nota fiscal de venda manual/talão com CFOP). NFSE = nota fiscal de serviço. OUTRO = qualquer coisa que NÃO seja nota fiscal: boleto, fatura, duplicata avulsa, guia de imposto, folha de pagamento, recibo, contrato, extrato, cupom, conhecimento de transporte (CT-e).",
    },
    issueDateText: { type: ["string", "null"], description: "DATA DE EMISSÃO exatamente como impressa (ex: 09/10/2026). NÃO é vencimento, saída nem entrada." },
    supplierCnpj: { type: ["string", "null"], description: "CNPJ do EMITENTE (quem vendeu), só números ou como impresso. null se ilegível." },
    noteNumber: { type: ["string", "null"], description: "Número da nota (campo 'Nº'), como impresso." },
    series: { type: ["string", "null"], description: "Série da nota, como impressa. null se não houver." },
    accessKey: { type: ["string", "null"], description: "Chave de acesso de 44 dígitos (pode estar impressa com espaços). null se não houver ou estiver ilegível — nunca complete dígitos." },
    cfops: {
      type: "array",
      items: { type: "string" },
      description: "CFOP de cada item da nota (4 dígitos), sem repetir, na ordem em que aparecem. Vazio se for NFSE ou se não estiver legível.",
    },
    productsTotal: { ...num, description: "Campo 'valor total dos produtos' (ou, em NFSE, o valor dos serviços)." },
    freight: { ...num, description: "Valor do frete. null se não houver." },
    insurance: { ...num, description: "Valor do seguro. null se não houver." },
    otherExpenses: { ...num, description: "Outras despesas acessórias. null se não houver." },
    discount: { ...num, description: "Desconto total. null se não houver." },
    ipi: { ...num, description: "Valor total do IPI. null se não houver." },
    icmsStValue: { ...num, description: "Valor do ICMS substituição tributária (ST). null se não houver." },
    icmsBase: { ...num, description: "Base de cálculo do ICMS. null se não houver." },
    icmsValue: { ...num, description: "Valor do ICMS (próprio). null se não houver." },
    noteTotal: { ...num, description: "Campo 'valor total da nota'." },
    confidence: { type: "number", description: "Confiança da leitura, de 0 a 1." },
    remarks: { type: ["string", "null"], description: "Qualquer dúvida de leitura. null se estiver tudo certo." },
  },
} as const;

const SYSTEM_PROMPT = `Você lê o CABEÇALHO fiscal de uma nota fiscal brasileira (DANFE/NF-e, NFS-e ou nota manual), pra escrituração contábil de ENTRADA (compras) de uma confecção. A empresa que lê é a DESTINATÁRIA (compradora); o fornecedor é o EMITENTE.

Regras:
- Leia SOMENTE a(s) página(s) indicadas na mensagem (a nota e, quando houver, as folhas de continuação). Não misture com outras notas do mesmo arquivo.
- Primeiro decida o tipo: só é NFE ou NFSE se for de fato uma nota fiscal. Boleto, fatura, guia, folha de pagamento, recibo, extrato, CT-e e similares são OUTRO — nesse caso devolva os demais campos como null (cfops vazio).
- Copie os valores EXATAMENTE como impressos. Números em formato brasileiro (1.234,56) viram número com ponto decimal (1234.56). Nunca invente nem complete: campo ilegível ou ausente = null.
- Datas: copie o texto impresso da data de EMISSÃO; quem converte é o sistema.
- CFOP: está na tabela de itens (coluna CFOP, 4 dígitos, ex: 5102, 6101, 5.102 → 5102). Liste os diferentes que aparecerem em TODOS os itens.
- Chave de acesso: 44 dígitos no quadro "Chave de acesso" do DANFE. Copie dígito por dígito.
- Confira: valor dos produtos + frete + seguro + outras despesas + IPI + ICMS ST − desconto deve bater com o valor total da nota. Se não bater, releia os campos antes de responder; se ainda não bater, explique em "remarks".`;

/** Dígito verificador da chave de acesso da NF-e (módulo 11, pesos 2..9 da direita pra esquerda). */
export function isValidAccessKey(key: string): boolean {
  if (!/^\d{44}$/.test(key)) return false;
  let weight = 2;
  let sum = 0;
  for (let i = 42; i >= 0; i--) {
    sum += Number(key[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  const dv = rest < 2 ? 0 : 11 - rest;
  return dv === Number(key[43]);
}

export async function extractPurchaseHeader(params: {
  fileBase64: string;
  mimeType: string;
  pageNumbers: number[];
}): Promise<PurchaseHeader> {
  const pagesText = params.pageNumbers.join(", ");
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          buildFileContentBlock(params.fileBase64, params.mimeType),
          { type: "text", text: `Leia o cabeçalho fiscal da nota que está na(s) página(s) ${pagesText} deste arquivo, conforme instruído.` },
        ],
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") throw new Error("A IA se recusou a ler esta nota.");
  if (message.stop_reason === "max_tokens") throw new Error("A leitura do cabeçalho ficou grande demais e foi cortada.");
  const text = message.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) throw new Error("A IA não retornou o cabeçalho desta nota.");

  const raw = JSON.parse(text) as {
    docType: PurchaseDocType;
    issueDateText: string | null;
    supplierCnpj: string | null;
    noteNumber: string | null;
    series: string | null;
    accessKey: string | null;
    cfops: string[] | null;
    productsTotal: number | null;
    freight: number | null;
    insurance: number | null;
    otherExpenses: number | null;
    discount: number | null;
    ipi: number | null;
    icmsStValue: number | null;
    icmsBase: number | null;
    icmsValue: number | null;
    noteTotal: number | null;
    confidence: number;
    remarks: string | null;
  };

  const remarks: string[] = [];
  if (raw.remarks?.trim()) remarks.push(raw.remarks.trim());
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // CNPJ: só vale com dígito verificador certo.
  let supplierCnpj: string | null = null;
  const cnpjDigits = (raw.supplierCnpj ?? "").replace(/\D/g, "");
  if (cnpjDigits.length === 14 && isValidTaxId(cnpjDigits)) supplierCnpj = cnpjDigits;
  else if (cnpjDigits) remarks.push("CNPJ do fornecedor lido não passou na conferência — conferir");

  let noteNumber = raw.noteNumber?.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || raw.noteNumber?.trim() || null;
  let series = raw.series?.trim() || null;

  // Chave de acesso: com o dígito verificador certo, ela traz CNPJ, série, número
  // e mês da própria nota — usa pra conferir (e corrigir) o que foi lido.
  let accessKey: string | null = null;
  const keyDigits = (raw.accessKey ?? "").replace(/\D/g, "");
  const issueDate = parseBrDate(raw.issueDateText);
  if (keyDigits.length === 44 && isValidAccessKey(keyDigits)) {
    accessKey = keyDigits;
    const keyCnpj = keyDigits.slice(6, 20);
    const keySeries = String(Number(keyDigits.slice(22, 25)));
    const keyNumber = String(Number(keyDigits.slice(25, 34)));
    const keyYm = `20${keyDigits.slice(2, 4)}-${keyDigits.slice(4, 6)}`;
    if (supplierCnpj && supplierCnpj !== keyCnpj) remarks.push("CNPJ lido diferente do da chave de acesso — usado o da chave");
    supplierCnpj = keyCnpj;
    if (noteNumber && String(Number(noteNumber)) !== keyNumber) remarks.push(`Nº da nota lido (${noteNumber}) diferente do da chave (${keyNumber}) — usado o da chave`);
    noteNumber = keyNumber;
    if (series && String(Number(series)) !== keySeries) remarks.push(`Série lida (${series}) diferente da chave (${keySeries}) — usada a da chave`);
    series = keySeries;
    if (issueDate && !issueDate.startsWith(keyYm)) {
      remarks.push(`Data de emissão lida (${issueDate.split("-").reverse().join("/")}) fora do mês da chave de acesso (${keyYm.slice(5)}/${keyYm.slice(0, 4)}) — conferir`);
    }
  } else if (keyDigits) {
    remarks.push("Chave de acesso lida não passou na conferência — deixada em branco, conferir");
  }

  const cfops = [...new Set((raw.cfops ?? []).map((c) => c.replace(/\D/g, "")).filter((c) => /^\d{4}$/.test(c)))];

  const productsTotal = n(raw.productsTotal);
  const noteTotal = n(raw.noteTotal);
  if (productsTotal !== null && noteTotal !== null) {
    const expected =
      productsTotal + (n(raw.freight) ?? 0) + (n(raw.insurance) ?? 0) + (n(raw.otherExpenses) ?? 0) + (n(raw.ipi) ?? 0) + (n(raw.icmsStValue) ?? 0) - (n(raw.discount) ?? 0);
    if (Math.abs(expected - noteTotal) > 0.05) {
      remarks.push(`Produtos + frete + impostos (R$ ${expected.toFixed(2)}) ≠ total da nota (R$ ${noteTotal.toFixed(2)}) — conferir`);
    }
  }

  return {
    docType: raw.docType,
    issueDate,
    supplierCnpj,
    noteNumber,
    series,
    accessKey,
    cfops,
    productsTotal,
    freight: n(raw.freight),
    ipi: n(raw.ipi),
    icmsBase: n(raw.icmsBase),
    icmsValue: n(raw.icmsValue),
    noteTotal,
    remark: remarks.length ? remarks.join("; ") : null,
    confidence: raw.confidence,
  };
}
