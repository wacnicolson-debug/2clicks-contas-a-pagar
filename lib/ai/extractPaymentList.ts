import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ExtractedPaymentLine = {
  lineNumber: number;
  date: string; // ISO yyyy-mm-dd — data em que o pagamento foi feito
  payeeNameRaw: string; // favorecido/fornecedor exatamente como aparece
  taxId: string | null;
  amount: number;
  paymentMethod: "BOLETO" | "PIX";
  noteNumber: string | null; // número do boleto/comprovante, se visível
};

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_payment_list_lines",
  description: "Registra cada pagamento (boleto ou pix) de uma relação/lista consolidada.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        description: "Uma entrada por pagamento já realizado na lista — não pule nenhum.",
        items: {
          type: "object",
          properties: {
            lineNumber: { type: "integer", description: "Número sequencial, começando em 1" },
            date: {
              type: "string",
              description: "Data em que o pagamento foi feito, formato AAAA-MM-DD",
            },
            payeeNameRaw: {
              type: "string",
              description: "Nome do favorecido/fornecedor exatamente como aparece na lista",
            },
            taxId: {
              type: ["string", "null"],
              description: "CNPJ ou CPF do favorecido, se estiver visível",
            },
            amount: { type: "number", description: "Valor pago, em reais, sempre positivo" },
            paymentMethod: {
              type: "string",
              enum: ["BOLETO", "PIX"],
              description:
                "Forma de pagamento dessa linha — pelo contexto da lista (ex: título da lista/coluna), ou pelo formato do dado (chave pix vs número de boleto/código de barras).",
            },
            noteNumber: {
              type: ["string", "null"],
              description:
                "Número do boleto, código de barras ou identificador do comprovante, se estiver visível, ou null.",
            },
          },
          required: ["lineNumber", "date", "payeeNameRaw", "taxId", "amount", "paymentMethod", "noteNumber"],
        },
      },
    },
    required: ["lines"],
  },
};

const SYSTEM_PROMPT = `Você lê relações/listas consolidadas de pagamentos já realizados por uma empresa brasileira — por exemplo, um relatório com vários boletos pagos, ou uma lista de pix enviados, cada linha um pagamento diferente pra um favorecido diferente. NÃO é um extrato bancário (que traz todas as movimentações da conta) nem uma nota fiscal individual — é uma lista/tabela que o próprio usuário organizou com os pagamentos que ele já fez.

Extraia TODA linha da lista, na ordem em que aparecem. Para cada linha, identifique:
- a data em que o pagamento foi feito (formato AAAA-MM-DD)
- o nome do favorecido/fornecedor exatamente como aparece (sem tentar "corrigir" ou padronizar)
- o CNPJ/CPF, se estiver visível
- o valor pago, sempre como número positivo
- a forma de pagamento: BOLETO ou PIX — pelo título/contexto da lista, pela coluna, ou pelo formato do dado (chave pix vs código de barras/linha digitável de boleto)
- o número do boleto ou identificador do comprovante, se estiver visível

Todas as linhas desta lista já representam dinheiro que SAIU da conta (pagamento já realizado, não uma cobrança futura). Não invente dados que não estejam na lista. Ignore linhas que são só cabeçalho ou total.`;

export async function extractPaymentListLines(params: {
  fileBase64: string;
  mimeType: string;
}): Promise<ExtractedPaymentLine[]> {
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "record_payment_list_lines" },
    messages: [
      {
        role: "user",
        content: [
          buildFileContentBlock(params.fileBase64, params.mimeType),
          {
            type: "text",
            text: "Extraia todos os pagamentos desta lista, conforme instruído.",
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error("A IA não retornou dados estruturados para esta lista.");
  }

  const result = toolUse.input as { lines: ExtractedPaymentLine[] };
  return result.lines;
}
