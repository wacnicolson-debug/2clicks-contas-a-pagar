import Anthropic from "@anthropic-ai/sdk";
import { buildFileContentBlock } from "./fileContentBlock";
import { parseBrDate, installmentDateProblems } from "./brDate";
import { isValidTaxId } from "@/lib/utils/taxId";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ExtractedInstallment = {
  amount: number;
  dueDate: string | null; // ISO yyyy-mm-dd, null se não tiver data visível no documento
  // Como estava impresso no documento (só nas notas lidas pela IA) — a
  // conversão pra dueDate é feita em código, ver brDate.ts.
  dueDateText?: string | null;
  parcelNumber?: string | null;
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
  // Data de emissão da nota (ISO), quando visível — usada só pra conferir
  // que nenhum vencimento cai antes dela.
  issueDate?: string | null;
  // Motivos pra não lançar automático e pedir conferência (data suspeita,
  // nota já lançada com outra data...). Vazio/ausente = leitura sem suspeita.
  reviewReasons?: string[];
  // Todas as parcelas desta página já estavam lançadas (mesma nota reenviada)
  // — registrada sem lançar nem perguntar nada.
  alreadyLaunched?: boolean;
};

type RawExtractedPage = Omit<ExtractedPage, "installments" | "issueDate"> & {
  issueDateText: string | null;
  installments: { parcelNumber: string | null; dueDateText: string | null; amount: number }[] | null;
};

// Formato de saída garantido pela API (structured outputs) — o modelo atual
// não aceita forçar a chamada de uma ferramenta, e isso aqui garante o JSON
// no formato certo do mesmo jeito.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      description: "Uma entrada por página do documento (cada página é, em princípio, uma nota/boleto diferente).",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pageNumber",
          "supplierNameRaw",
          "taxId",
          "noteNumber",
          "issueDateText",
          "installments",
          "confidence",
          "notes",
          "duplicateOfPageNumber",
          "documentDirection",
        ],
        properties: {
          pageNumber: { type: "integer", description: "Número da página no PDF, começando em 1" },
          supplierNameRaw: {
            type: "string",
            description:
              "Nome do fornecedor/emissor exatamente como aparece no documento — só o nome/razão social em si, nunca um número (nota fiscal, CNPJ, código de barras, linha digitável) que esteja perto dele no layout. REGRA: esse campo é sempre texto, nunca tem dígito nenhum — se o que você leu tem qualquer número junto (no início, no meio ou no fim), é sinal de que pegou um número vizinho por engano; releia e devolva só as letras do nome de verdade.",
          },
          taxId: {
            type: ["string", "null"],
            description:
              "CNPJ ou CPF da MESMA parte cujo nome foi para supplierNameRaw, se estiver visível. Nunca o CNPJ de uma das empresas donas do sistema (ex: o da GLM como destinatária de uma nota de compra) — numa DANFE de compra, é o CNPJ do bloco do EMITENTE. Se não achar o CNPJ dessa parte, null.",
          },
          noteNumber: {
            type: ["string", "null"],
            description:
              "Número da nota fiscal, fatura ou boleto, exatamente como aparece no documento, ou null se não houver número visível",
          },
          issueDateText: {
            type: ["string", "null"],
            description:
              "Data de emissão do documento EXATAMENTE como está impressa (ex: \"25/09/2026\"), sem converter. null se não houver.",
          },
          installments: {
            type: "array",
            description:
              "Uma entrada por vencimento/parcela encontrado no documento, na ordem em que aparecem. A maioria dos documentos tem só uma.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["parcelNumber", "dueDateText", "amount"],
              properties: {
                parcelNumber: {
                  type: ["string", "null"],
                  description:
                    "Número/identificação da parcela ou duplicata EXATAMENTE como impresso (ex: \"001\", \"1/7\", \"0180491-2\"). null se o documento não numera as parcelas.",
                },
                dueDateText: {
                  type: ["string", "null"],
                  description:
                    "Data de vencimento desta parcela EXATAMENTE como está impressa no documento (ex: \"09/10/2026\"), caractere por caractere — NÃO converta pra outro formato e NÃO reordene dia e mês; o sistema converte. null se não houver data visível.",
                },
                amount: { type: "number", description: "Valor desta parcela, em reais" },
              },
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
            anyOf: [{ type: "string", enum: ["COMPRA", "VENDA"] }, { type: "null" }],
            description:
              "SÓ para nota fiscal (NF-e/DANFE): 'VENDA' se a GLM aparecer como EMITENTE (ela vendeu), 'COMPRA' se a GLM aparecer como DESTINATÁRIA (ela comprou). null pra qualquer outro tipo de documento (boleto, guia, recibo) onde essa distinção emitente/destinatário não se aplica do mesmo jeito.",
          },
        },
      },
    },
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
- o CNPJ/CPF dessa MESMA parte (o fornecedor/cliente que você extraiu), se estiver visível — nunca o CNPJ de nenhuma das empresas acima, mesmo que ele apareça maior ou primeiro no documento
- o número da nota fiscal, fatura ou boleto, se estiver visível (exatamente como aparece, ou null se não achar)
- o(s) valor(es) e a(s) respectiva(s) data(s) de vencimento — um documento pode ter mais de uma parcela/vencimento. COPIE cada data exatamente como está impressa ("09/10/2026"), sem converter de formato — o sistema faz a conversão. Quando houver várias parcelas (fatura/duplicatas de DANFE), liste TODAS, cada uma com o número da duplicata, a data e o valor da MESMA linha/célula da tabela (na DANFE essa tabela costuma vir em colunas lado a lado — leia cada trio número/vencimento/valor junto, sem misturar com o vizinho). Os valores costumam ser iguais, com a diferença de centavos numa única parcela — confira em qual linha ela está, não assuma.
- a data de emissão do documento, também copiada exatamente como impressa
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
  // Modelo mais preciso, pensando com calma (effort alto) — o usuário prefere
  // que a leitura demore a lançar errado. Streaming porque uma leitura
  // caprichada de um PDF com várias notas pode passar do tempo de uma chamada
  // simples.
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    // Se a IA recusar ler o documento por engano (filtro de segurança), a
    // própria API tenta de novo em outro modelo em vez de falhar.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: buildSystemPrompt(params.ownNames),
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
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("A IA se recusou a ler este documento.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("A leitura deste documento ficou grande demais e foi cortada — divida o arquivo.");
  }

  const text = message.content.find(
    (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text"
  )?.text;
  if (!text) {
    throw new Error("A IA não retornou dados estruturados para este documento.");
  }

  const result = JSON.parse(text) as { pages: RawExtractedPage[] | null | undefined };
  // A IA às vezes volta com um campo obrigatório vazio/nulo pra alguma página
  // (ou até pra "pages" inteiro) mesmo o schema pedindo o contrário — sem essa
  // validação, 1 página ruim quebrava o processamento do arquivo INTEIRO.
  const pages = result.pages ?? [];
  return pages
    .map((page): ExtractedPage => {
      const { issueDateText, ...rest } = page;
      const issueDate = parseBrDate(issueDateText);
      const installments = (page.installments ?? [])
        .map((i) => ({
          amount: i.amount,
          // Data ilegível/fora do formato vira null — igual a "não achou
          // vencimento", e a tela de perguntas pede a data.
          dueDate: parseBrDate(i.dueDateText),
          dueDateText: i.dueDateText,
          parcelNumber: i.parcelNumber,
        }))
        // Ordem cronológica pro lançamento (parcela 1/N = a que vence
        // primeiro); as sem data ficam por último.
        .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
      return {
        ...rest,
        // CNPJ/CPF com dígito verificador errado é leitura ruim — melhor sem
        // CNPJ (o fornecedor é achado pelo nome) do que com um inventado.
        taxId: isValidTaxId(rest.taxId) ? rest.taxId : null,
        issueDate,
        installments,
        reviewReasons: installmentDateProblems(installments, issueDate),
      };
    })
    .filter((page) => {
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
