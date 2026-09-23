import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ExtractedPaymentLine = {
  lineNumber: number;
  date: string; // ISO yyyy-mm-dd — data em que o pagamento foi feito
  payeeNameRaw: string; // fornecedor real já resolvido (beneficiário final, quando existir)
  taxId: string | null;
  amount: number;
  paymentMethod: "BOLETO" | "PIX";
  noteNumber: string | null; // número do boleto/comprovante, se visível
  pixKey: string | null; // chave pix do favorecido, se estiver visível na lista (só faz sentido quando paymentMethod = PIX)
};

// Formato bruto devolvido pela IA — com os dois campos de beneficiário
// SEPARADOS. A decisão de qual usar (final quando existir, senão o
// genérico) é feita em código logo abaixo, não pela IA: pedir pra ela
// "decidir" qual usar por linha era inconsistente em documentos com muitos
// comprovantes — pedir pra ela só LER os dois campos que existem é uma
// tarefa bem mais simples e confiável.
type RawExtractedPaymentLine = {
  lineNumber: number;
  date: string;
  beneficiaryNameRaw: string;
  beneficiaryTaxId: string | null;
  finalBeneficiaryNameRaw: string | null;
  finalBeneficiaryTaxId: string | null;
  amount: number;
  paymentMethod: "BOLETO" | "PIX";
  noteNumber: string | null;
  pixKey: string | null;
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
              description:
                "Data em que o dinheiro efetivamente saiu da conta, formato AAAA-MM-DD. MUITO IMPORTANTE: quando o comprovante trouxer MAIS DE UM campo de data (ex: 'Realizado' e 'Pagamento' separados — comum em pagamento agendado, onde o agendamento foi registrado num dia mas o débito de fato aconteceu em outro), use SEMPRE o campo 'Pagamento' (a data do débito em si), nunca 'Realizado' (que é só quando a ordem foi registrada/agendada). Essa data precisa bater exatamente com a data que aparece no extrato bancário depois — usar a data errada quebra a conciliação.",
            },
            beneficiaryNameRaw: {
              type: "string",
              description:
                "Nome/Razão Social do campo 'Beneficiário' (o principal/genérico do comprovante) — exatamente como está escrito. Sempre preencha este campo, mesmo quando também existir um 'Beneficiário final' separado.",
            },
            beneficiaryTaxId: {
              type: ["string", "null"],
              description: "CNPJ/CPF do campo 'Beneficiário' (o genérico), se estiver visível.",
            },
            finalBeneficiaryNameRaw: {
              type: ["string", "null"],
              description:
                "Nome/Razão Social do campo especificamente rotulado 'Beneficiário final' (ou 'Beneficiário Final'), SÓ quando esse campo existir separado do 'Beneficiário' genérico no comprovante. null quando o comprovante não tiver esse campo separado (nesse caso o 'Beneficiário' genérico já É o fornecedor real).",
            },
            finalBeneficiaryTaxId: {
              type: ["string", "null"],
              description: "CNPJ/CPF do campo 'Beneficiário final', se esse campo existir e o CNPJ estiver visível. null se não houver campo 'Beneficiário final'.",
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
            pixKey: {
              type: ["string", "null"],
              description:
                "Chave pix do favorecido (CPF/CNPJ, e-mail, telefone ou chave aleatória), exatamente como aparece na lista, se estiver visível — só faz sentido quando paymentMethod é PIX. Null se não houver chave visível.",
            },
          },
          required: [
            "lineNumber",
            "date",
            "beneficiaryNameRaw",
            "beneficiaryTaxId",
            "finalBeneficiaryNameRaw",
            "finalBeneficiaryTaxId",
            "amount",
            "paymentMethod",
            "noteNumber",
            "pixKey",
          ],
        },
      },
    },
    required: ["lines"],
  },
};

const SYSTEM_PROMPT = `Você lê comprovantes/listas de pagamentos já realizados por uma empresa brasileira — por exemplo, um relatório com vários boletos pagos, uma lista de pix enviados, um comprovante individual (Beneficiário/Pagador/Valor), OU uma única linha recortada direto da tela do extrato do banco (ícone + data + código + descrição + valor, sem os campos "Beneficiário"/"Pagador" escritos por extenso — comum em taxas/juros/débitos automáticos como IOF, tarifas, DOC/TED). Todos esses formatos são válidos e devem ser extraídos — o usuário está fazendo conciliação bancária mandando um pagamento por vez, do jeito que tiver a mão; NÃO recuse uma linha só porque ela parece uma linha de extrato — extraia ela também.

Extraia TODO comprovante/linha da imagem, na ordem em que aparecem. Trate CADA comprovante como uma tarefa própria, com calma — não corra pra terminar rápido, mesmo que existam dezenas deles no mesmo arquivo. Antes de preencher os campos de um comprovante, releia ele até o final (os comprovantes costumam ter, nessa ordem: Beneficiário, Pagador, Beneficiário final, Datas, Valores) — não pare de procurar assim que achar o "Beneficiário" genérico, o "Beneficiário final" normalmente vem DEPOIS dele no mesmo comprovante. Para cada um, LEIA OS CAMPOS EXATAMENTE COMO APARECEM, sem decidir nem resumir nada — a extração é só leitura literal:
- a data em que o pagamento foi feito (formato AAAA-MM-DD)
- o Nome/Razão Social e o CNPJ/CPF do campo "Beneficiário" (o principal do comprovante) — sempre preencha isso. Quando não existir um campo "Beneficiário"/"Destinatário" escrito por extenso (linha solta de extrato, ex: "DÉB.IOF EMPRÉSTIMOS", "TARIFA MANUTENÇÃO CONTA"), use a própria descrição da linha como beneficiaryNameRaw, exatamente como está escrita — nunca deixe vazio.
- SEPARADAMENTE, o Nome/Razão Social e o CNPJ/CPF do campo "Beneficiário final", SÓ SE esse campo existir escrito no comprovante como algo distinto do "Beneficiário" — é comum um boleto estar cedido/securitizado (o "Beneficiário" é uma cobrança/securitizadora/fundo, ex: "MULTIPLIKE SECURITIZADORA S.A.", "ATLANTA FUNDO INV D CRED N PAD", "O. A. ALVES COBRANCA E ASSESSORIA FINANC" — e o comprovante traz um "Beneficiário final" à parte com o fornecedor real). Se não existir esse campo separado no comprovante, deixe null — não invente nem repita o "Beneficiário" genérico aqui.
- o valor pago, sempre como número positivo (uma linha de extrato pode mostrar o valor com sinal negativo ou sufixo "D"/"Débito" — é só a forma de marcar débito, o valor em si continua sendo o mesmo número, positivo)
- a forma de pagamento: BOLETO ou PIX — pelo título/contexto, pela coluna, ou pelo formato do dado (chave pix vs número de boleto/linha digitável). Se a linha não deixar claro (ex: débito automático, IOF, tarifa) e não houver nenhuma pista de PIX, use BOLETO.
- o número do boleto/documento ou identificador do comprovante, se estiver visível
- a chave pix do favorecido, se estiver visível na lista (só relevante quando a forma de pagamento é PIX)

Todas as linhas já representam dinheiro que SAIU da conta (pagamento já realizado, não uma cobrança futura). Não invente dados que não estejam no comprovante/linha. Ignore linhas que são só cabeçalho ou total.`;

export async function extractPaymentListLines(params: {
  fileBase64: string;
  mimeType: string;
}): Promise<ExtractedPaymentLine[]> {
  // Streaming em vez de chamada bloqueante — com max_tokens alto (listas
  // grandes de pagamentos), o SDK exige streaming pra operações que podem
  // passar de 10 minutos, senão recusa a chamada de cara.
  const stream = client.messages.stream({
    model: "claude-sonnet-5",
    max_tokens: 32000,
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
  const message = await stream.finalMessage();

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error("A IA não retornou dados estruturados para esta lista.");
  }

  const result = toolUse.input as { lines: RawExtractedPaymentLine[] };
  // Decisão de qual beneficiário usar é sempre feita aqui, em código — nunca
  // pela IA: quando existe um "Beneficiário final" separado, ele é o
  // fornecedor real (o genérico é só o intermediário/cobrança/securitizadora
  // que recebeu o boleto cedido); senão, o "Beneficiário" genérico já é o
  // fornecedor de verdade.
  //
  // A IA às vezes não consegue ler um comprovante específico (página
  // ilegível, corrompida, formato diferente) e volta com valor/data vazios
  // mesmo o campo sendo obrigatório no schema — sem essa filtragem, 1 linha
  // ruim quebrava o processamento do arquivo INTEIRO (nenhuma linha boa era
  // lançada). Descarta só a linha problemática, deixa o resto seguir.
  return result.lines
    .filter((line) => {
      const valid =
        Number.isFinite(line.amount) &&
        line.amount > 0 &&
        !!line.date &&
        !!(line.finalBeneficiaryNameRaw ?? line.beneficiaryNameRaw);
      if (!valid) {
        console.error(
          `Linha ${line.lineNumber} da relação de pagamentos veio com dado inválido/ilegível, ignorada:`,
          JSON.stringify(line)
        );
      }
      return valid;
    })
    .map((line) => ({
      lineNumber: line.lineNumber,
      date: line.date,
      payeeNameRaw: line.finalBeneficiaryNameRaw ?? line.beneficiaryNameRaw,
      taxId: line.finalBeneficiaryTaxId ?? line.beneficiaryTaxId,
      amount: line.amount,
      paymentMethod: line.paymentMethod,
      noteNumber: line.noteNumber,
      pixKey: line.pixKey,
    }));
}
