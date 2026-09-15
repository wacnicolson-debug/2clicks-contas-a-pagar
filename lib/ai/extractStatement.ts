import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ExtractedStatementLine = {
  lineNumber: number;
  date: string; // ISO yyyy-mm-dd
  description: string; // texto do histórico/descrição do banco, como aparece
  amount: number; // sempre positivo — o sinal vem do campo "direction"
  direction: "SAIDA" | "ENTRADA";
};

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_statement_lines",
  description: "Registra cada linha de movimentação do extrato bancário.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        description: "Uma entrada por linha de movimentação do extrato — não pule nenhuma, nem tarifas pequenas.",
        items: {
          type: "object",
          properties: {
            lineNumber: { type: "integer", description: "Número sequencial da linha, começando em 1" },
            date: {
              type: "string",
              description: "Data do lançamento no extrato, formato AAAA-MM-DD",
            },
            description: {
              type: "string",
              description: "Texto do histórico/descrição exatamente como aparece no extrato",
            },
            amount: {
              type: "number",
              description: "Valor da movimentação, sempre positivo (o sentido vai em 'direction')",
            },
            direction: {
              type: "string",
              enum: ["SAIDA", "ENTRADA"],
              description:
                "SAIDA = dinheiro saiu da conta (débito/pagamento); ENTRADA = dinheiro entrou (crédito/recebimento). Alguns extratos mostram isso com sinal negativo/positivo, outros com colunas separadas ou letra D/C — converta corretamente pra esse campo.",
            },
          },
          required: ["lineNumber", "date", "description", "amount", "direction"],
        },
      },
    },
    required: ["lines"],
  },
};

const SYSTEM_PROMPT = `Você lê extratos bancários brasileiros (PDF exportado do internet banking), com qualidade variável.

Extraia TODA linha de movimentação do extrato, na ordem em que aparecem — inclusive tarifas pequenas, juros, IOF, estornos, qualquer coisa que mexeu no saldo. Não pule nada, mesmo que pareça pouco relevante: o objetivo é comparar depois com os lançamentos já registrados no sistema, então uma linha faltando quebra essa comparação.

Para cada linha, identifique:
- a data (formato AAAA-MM-DD)
- o texto do histórico/descrição exatamente como aparece (não resuma nem "traduza")
- o valor, sempre como número positivo
- a direção: SAIDA (dinheiro saiu da conta) ou ENTRADA (dinheiro entrou) — extratos brasileiros mostram isso de formas diferentes (sinal negativo, colunas separadas de débito/crédito, letra D/C) — identifique corretamente em cada caso.

Não invente linhas nem valores. Ignore linhas que são só cabeçalho, saldo do dia, saldo anterior/final ou totalizadores — extraia só movimentações de fato.`;

export async function extractStatementLines(params: {
  fileBase64: string;
  mimeType: string;
}): Promise<ExtractedStatementLine[]> {
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "record_statement_lines" },
    messages: [
      {
        role: "user",
        content: [
          buildFileContentBlock(params.fileBase64, params.mimeType),
          {
            type: "text",
            text: "Extraia todas as linhas de movimentação deste extrato bancário, conforme instruído.",
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error("A IA não retornou dados estruturados para este extrato.");
  }

  const result = toolUse.input as { lines: ExtractedStatementLine[] | null | undefined };
  // A IA às vezes volta com um campo obrigatório vazio/nulo pra alguma linha
  // (ou até pra "lines" inteiro) mesmo o schema pedindo o contrário — sem essa
  // validação, 1 linha ruim quebrava o processamento do extrato INTEIRO.
  const rawLines = result.lines ?? [];
  const validLines = rawLines.filter((line) => {
    const valid =
      Number.isFinite(line.amount) &&
      line.amount > 0 &&
      !!line.date &&
      !!line.description &&
      (line.direction === "SAIDA" || line.direction === "ENTRADA");
    if (!valid) {
      console.error(
        `Linha ${line.lineNumber} do extrato veio com dado inválido/ilegível, ignorada:`,
        JSON.stringify(line)
      );
    }
    return valid;
  });

  // Um extrato de verdade sempre tem pelo menos 1 movimentação — 0 linhas
  // (aqui ou já na resposta bruta da IA) é sinal de algo errado, não um
  // resultado válido. Em vez de "completar" silenciosamente sem lançar nada
  // (o que parece só "não aconteceu nada" pra quem enviou), joga um erro
  // com o que a IA realmente devolveu, pra dar pra investigar direto pelo
  // Inngest sem precisar reproduzir o problema de novo.
  if (validLines.length === 0) {
    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    throw new Error(
      `A IA não conseguiu ler nenhuma movimentação válida deste extrato. ` +
        `Linhas brutas devolvidas: ${rawLines.length}. ` +
        `Amostra: ${JSON.stringify(rawLines.slice(0, 2))}. ` +
        `Texto adicional da IA: ${textBlock?.text?.slice(0, 500) ?? "(nenhum)"}`
    );
  }

  return validLines;
}
