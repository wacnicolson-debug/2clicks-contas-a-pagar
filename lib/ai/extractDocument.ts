import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ExtractedInstallment = {
  amount: number;
  dueDate: string | null; // ISO yyyy-mm-dd, null se não tiver data visível no documento
};

export type ExtractedPage = {
  pageNumber: number;
  supplierNameRaw: string;
  taxId: string | null; // CNPJ/CPF, se visível
  noteNumber: string | null; // número da nota fiscal/fatura/boleto, se visível
  installments: ExtractedInstallment[];
  confidence: number; // 0-1
  notes: string | null;
  // Se essa página for 2ª/3ª via, continuação (ex: "folha 2/2"), ou anexo sem
  // valor próprio (ex: detalhamento de imposto) da MESMA nota de uma página
  // anterior, aponta o número daquela página. Evita lançar a mesma nota 2x.
  duplicateOfPageNumber: number | null;
  // Preenchido só quando a página veio de uma relação de pagamentos (onde a
  // forma de pagamento já foi lida da própria lista) — usado pra pré-marcar
  // a pergunta "Forma de pagamento" com o valor certo em vez de nascer
  // sempre em "Boleto". Ausente/null nas notas normais, onde isso não é
  // conhecido de antemão.
  knownPaymentMethod?: "BOLETO" | "PIX" | null;
  // Idem, pra chave pix já lida da própria relação de pagamentos.
  knownPixKey?: string | null;
  // Preenchido só quando a origem já sabe se é Fornecedor ou Cliente (ex:
  // direção do extrato bancário) — pré-marca a pergunta em vez de nascer
  // sempre em "Fornecedor".
  knownKind?: "FORNECEDOR" | "CLIENTE" | null;
  // Sentido da nota fiscal, quando dá pra saber pela própria nota (GLM como
  // emitente = venda, GLM como destinatária = compra). Existe pra pegar o
  // caso de uma empresa que é fornecedora E cliente ao mesmo tempo (compra
  // de um lado, vende do outro) — sem isso, uma nota nova sempre herdava o
  // sentido aprendido antes, mesmo quando essa nota específica é o oposto.
  documentDirection?: "COMPRA" | "VENDA" | null;
  // Calculado no processamento (não pela IA): true quando documentDirection
  // bateu diferente do perfil já salvo do fornecedor — sinaliza que essa
  // pergunta é um "confirma de novo" e não deve sobrescrever o perfil.
  directionConflict?: boolean;
};

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_extracted_pages",
  description:
    "Registra os dados extraídos de cada página do documento (cada página é uma nota/boleto diferente).",
  input_schema: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            pageNumber: { type: "integer", description: "Número da página no PDF, começando em 1" },
            supplierNameRaw: {
              type: "string",
              description:
                "Nome do fornecedor/emissor exatamente como aparece no documento — só o nome/razão social em si, nunca um número (nota fiscal, CNPJ, código de barras, linha digitável) que esteja perto dele no layout. REGRA: esse campo é sempre texto, nunca tem dígito nenhum — se o que você leu tem qualquer número junto (no início, no meio ou no fim), é sinal de que pegou um número vizinho por engano; releia e devolva só as letras do nome de verdade.",
            },
            taxId: {
              type: ["string", "null"],
              description: "CNPJ ou CPF do fornecedor/emissor, se estiver visível no documento",
            },
            noteNumber: {
              type: ["string", "null"],
              description:
                "Número da nota fiscal, fatura ou boleto, exatamente como aparece no documento, ou null se não houver número visível",
            },
            installments: {
              type: "array",
              description:
                "Uma entrada por vencimento/parcela encontrado no documento. A maioria dos documentos tem só uma.",
              items: {
                type: "object",
                properties: {
                  amount: { type: "number", description: "Valor da parcela, em reais" },
                  dueDate: {
                    type: ["string", "null"],
                    description: "Data de vencimento no formato AAAA-MM-DD, ou null se não houver data visível",
                  },
                },
                required: ["amount", "dueDate"],
              },
            },
            confidence: {
              type: "number",
              description: "Confiança da leitura, de 0 a 1",
            },
            notes: {
              type: ["string", "null"],
              description: "Qualquer observação relevante (ex: documento ilegível, tipo de documento identificado)",
            },
            duplicateOfPageNumber: {
              type: ["integer", "null"],
              description:
                "Preencha com o número de uma página ANTERIOR se esta página for a mesma nota fiscal/fatura repetida — 2ª via, 3ª via, folha de continuação (ex: 'folha 2/2'), ou um anexo sem valor de cobrança próprio (ex: detalhamento de imposto/discriminação de serviço da mesma nota). Deixe null se esta página é uma nota/cobrança que ainda não apareceu antes no arquivo.",
            },
            documentDirection: {
              type: ["string", "null"],
              enum: ["COMPRA", "VENDA", null],
              description:
                "SÓ para nota fiscal (NF-e/DANFE): 'VENDA' se a GLM aparecer como EMITENTE (ela vendeu), 'COMPRA' se a GLM aparecer como DESTINATÁRIA (ela comprou). null pra qualquer outro tipo de documento (boleto, guia, recibo) onde essa distinção emitente/destinatário não se aplica do mesmo jeito.",
            },
          },
          required: [
            "pageNumber",
            "supplierNameRaw",
            "taxId",
            "noteNumber",
            "installments",
            "confidence",
            "notes",
            "duplicateOfPageNumber",
            "documentDirection",
          ],
        },
      },
    },
    required: ["pages"],
  },
};

function buildSystemPrompt(ownNames: string[]): string {
  // Uma conta desta pode pagar contas de VÁRIAS empresas do mesmo grupo na
  // mesma planilha (ex: GLM, Santa Luzia, MAAC, WAAC, MRC) — qualquer uma
  // delas pode aparecer como emitente/destinatário/pagadora numa nota, então
  // a regra de "não lance a própria empresa" precisa valer pra todas, não só
  // pra uma.
  const namesList = ownNames.map((n) => `"${n}"`).join(", ");
  const ownNameExample = ownNames[0] ?? "a empresa";

  return `Você lê documentos financeiros brasileiros (notas fiscais, boletos, contas de consumo como CEMIG, guias como DARF, recibos) que podem vir digitalizados/fotografados, com qualidade variável.

Cada página do arquivo é, EM PRINCÍPIO, um documento financeiro diferente. Para cada página, identifique:
- quem é o fornecedor/emissor (o nome exatamente como aparece, sem tentar "corrigir" ou padronizar)

REGRA MAIS IMPORTANTE DE TODAS — esta conta lança contas de VÁRIAS empresas do mesmo grupo na mesma planilha: ${namesList}. NUNCA extraia nenhum desses nomes (nem variações de grafia/acentuação/maiúscula/razão social) como fornecedor/cliente em "supplierNameRaw" — são as próprias empresas donas deste sistema. Qualquer uma delas pode aparecer no documento em qualquer papel (como contribuinte pagando uma guia, como emitente de uma nota fiscal de venda, como sacado/pagador de um boleto, etc.), mas NUNCA é ela mesma quem deve ser lançada. Sempre que o nome de QUALQUER UMA delas aparecer, procure a OUTRA parte do documento — é essa outra parte que é o fornecedor ou cliente de verdade:
- Guia de recolhimento (DARF, GPS/INSS, GUIA DE FGTS, GRU e similares): uma dessas empresas é a contribuinte/pagadora — nesse caso não tem uma "outra empresa" pra extrair, então use o TIPO da guia como fornecedor (ex: "GUIA DE FGTS", "DARF", "GPS/INSS"). Isso também evita que um FGTS e um DARF (impostos diferentes) virem "o mesmo fornecedor" e herdem categoria um do outro.
- Nota fiscal de VENDA emitida por uma dessas empresas (ela aparece como emitente): o fornecedor/cliente é o DESTINATÁRIO da nota (quem comprou), não ela.
- Boleto em que uma dessas empresas é a pagadora/sacada: o fornecedor é o BENEFICIÁRIO do boleto (quem recebe), não ela.
- Se depois de procurar não sobrar nenhuma outra parte identificável no documento, só então use algo descritivo do próprio documento (nunca o nome de nenhuma dessas empresas).
- o CNPJ/CPF, se estiver visível
- o número da nota fiscal, fatura ou boleto, se estiver visível (exatamente como aparece, ou null se não achar)
- o(s) valor(es) e a(s) respectiva(s) data(s) de vencimento — um documento pode ter mais de uma parcela/vencimento
- uma nota de confiança da sua leitura
- SÓ para nota fiscal (NF-e/DANFE): preencha "documentDirection" com "VENDA" se UMA DESSAS EMPRESAS aparecer como EMITENTE (campo "Emitente" ou o cabeçalho da nota — ela vendeu), ou "COMPRA" se aparecer como DESTINATÁRIO/REMETENTE (ela comprou). Se nenhuma das empresas da lista aparecer no documento (nem como emitente nem como destinatário), deixe "documentDirection" e "supplierNameRaw" como sua melhor leitura mesmo assim, mas registre em "notes" que o documento não parece ser de nenhuma das empresas de ${ownNameExample} — pode ser um arquivo enviado por engano. Deixe "documentDirection" null pra qualquer outro tipo de documento (boleto, guia, recibo) — essa distinção emitente/destinatário só vale pra nota fiscal.

Não invente dados que não estejam no documento. Se não achar uma data de vencimento, retorne null nesse campo em vez de adivinhar.

MUITO IMPORTANTE — evite lançar a mesma cobrança duas vezes: é comum um arquivo trazer a MESMA nota fiscal/fatura repetida várias vezes (1ª via do cliente, 2ª via da contabilidade, 3ª via de controle) ou dividida em mais de uma página física (ex: "folha 1/2" e "folha 2/2", ou a nota seguida de um anexo/detalhamento de imposto sem cobrança própria). Compare cada página com as anteriores do MESMO arquivo: se o número da nota fiscal/fatura, fornecedor e valores baterem com uma página já vista, preencha "duplicateOfPageNumber" com o número dessa página anterior (a primeira vez que aquela nota apareceu) em vez de repetir o lançamento. Só deixe "duplicateOfPageNumber" nulo quando a página trouxer uma cobrança que ainda não tinha aparecido no arquivo.

MUITO IMPORTANTE — nota que continua em mais de uma página física (não é só isso ser marcado como duplicata): as páginas seguintes de uma mesma nota são ignoradas no lançamento (viram só "duplicateOfPageNumber"), então TODO valor e vencimento daquela nota precisam estar na entrada da PRIMEIRA página onde ela aparece — mesmo que o valor total/a data de vencimento só apareça visualmente numa página seguinte (ex: "folha 2/2" com o total ao final). Antes de finalizar cada nota, releia todas as páginas dela (a primeira e as marcadas como continuação) e junte o valor/vencimento corretos na entrada da primeira página. Nunca deixe "installments" vazio ou com valor errado na primeira página só porque o número estava fisicamente numa página posterior.`;
}

export async function extractDocumentPages(params: {
  fileBase64: string;
  mimeType: string;
  ownNames: string[];
}): Promise<ExtractedPage[]> {
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: buildSystemPrompt(params.ownNames),
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "record_extracted_pages" },
    messages: [
      {
        role: "user",
        content: [
          buildFileContentBlock(params.fileBase64, params.mimeType),
          {
            type: "text",
            text: "Extraia os dados de cada página deste documento, conforme instruído.",
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error("A IA não retornou dados estruturados para este documento.");
  }

  const result = toolUse.input as { pages: ExtractedPage[] | null | undefined };
  // A IA às vezes volta com um campo obrigatório vazio/nulo pra alguma página
  // (ou até pra "pages" inteiro) mesmo o schema pedindo o contrário — sem essa
  // validação, 1 página ruim quebrava o processamento do arquivo INTEIRO.
  const pages = result.pages ?? [];
  return pages.filter((page) => {
    const validInstallments =
      Array.isArray(page.installments) &&
      page.installments.every((i) => Number.isFinite(i.amount) && i.amount > 0);
    const valid = !!page.supplierNameRaw && validInstallments;
    if (!valid) {
      console.error(
        `Página ${page.pageNumber} veio com dado inválido/ilegível, ignorada:`,
        JSON.stringify(page)
      );
    }
    return valid;
  });
}
