# Contexto do Projeto: App de Gestão de Contas a Pagar

App de Gestão de Contas a Pagar (SaaS multi-empresa, estilo TOTVS)

## Objetivo
Transformar em um produto para vender a outras empresas, não só uso próprio.

## Modelo de dados / Multi-tenant
- Cada empresa cria seu próprio cadastro; dados ficam em nuvem.
- Cada empresa faz upload dos seus próprios documentos de cobrança (dados separados entre empresas).
- Grupo empresarial de exemplo: 5 empresas de setores diferentes, cada uma com sua própria pessoa lançando dados (login separado por empresa).

## Classificação de custo
- Cada empresa/setor precisa de suas próprias categorias de classificação de custo (não é lista única).
- Classificação de custo configurável por fornecedor, para lançamentos futuros desse fornecedor serem classificados automaticamente.
- Um fornecedor pode ter mais de uma categoria (ex: "Takara" vende máquinas e óleo lubrificante).
- REGRA ATUALIZADA (ver seção "Fluxo de extração / lançamento de documentos" → "Regra de automação CONFIRMADA"): o app pergunta a classificação apenas na primeira nota de cada fornecedor; da segunda em diante é 100% automático, mesmo que o fornecedor tenha categorias variáveis como a Takara. Erros de classificação nesses casos são corrigidos manualmente pelo usuário depois.

## Campos desejados
- Fornecedor
- Valor separado por parcelas
- Vencimento
- Classificação do custo (ex: mão de obra, serviço, matéria prima)

## Processamento de documentos
- Deve processar arquivos de imagem/escaneados com várias notas fiscais e boletos (ex: DARF, CEMIG) em um único arquivo.
- Identificação de fornecedor/valor/vencimento a partir dos documentos — RESOLVIDO: usar **IA que lê o documento inteiro** (não OCR tradicional de campo fixo, nem leitura de código de barras isolado). Motivo dado pelo usuário: o valor e as datas de vencimento aparecem em lugares diferentes dependendo do tipo de documento (uma nota da CEMIG não se parece em nada com um DARF), então precisa de algo flexível o suficiente pra entender o documento como um todo, não um molde fixo por tipo de documento. Essa mesma leitura por IA identifica o fornecedor, o(s) valor(es) e a(s) data(s) de vencimento em uma única passada.

## Documento interno de referência: "Obrigação a Pagar"
Campos: código, credor (nome/código), vencimento, valor, descrição, código do fornecedor, data, usuário.

## Login / Offline
- Login simples: nome de usuário e senha (sem redes sociais, sem OAuth de terceiros por enquanto).
- CONFIRMADO: app deve funcionar **offline de verdade** (sem internet) e sincronizar depois quando conectar.
- ESCOPO DEFINIDO (opção A): offline serve apenas para **consultar dados já baixados/sincronizados anteriormente** (ex: ver contas já lançadas). Para **lançar algo novo** (novo documento, nova conta a pagar), precisa de internet — não há lançamento offline com fila de sincronização.
- Isso resolve a tensão com "dados na nuvem" e planilha Google Sheets "viva": lançamentos sempre acontecem online, então a planilha sempre reflete dados reais no momento em que são inseridos. Offline = modo leitura de cache local.

## Telas do app (ATUALIZADO — não é mais 1 tela só)

### Tela principal
- Botão "Adicionar Documentos" em destaque.
- Botão "Adicionar Extrato" (NOVO) — CONFIRMADO: usuário sobe o extrato bancário, o app compara com os lançamentos já feitos (via documentos) e identifica os itens do extrato que **NÃO batem com nenhum lançamento existente**. Para esses itens "órfãos", o app pergunta ao usuário como classificar (mesmo espírito do fluxo de lançamento de documentos), cobrindo casos como:
  - Juros
  - IOF
  - Gastos que não geram nota fiscal (ex: Uber)
  - Isso garante que o controle de custos capture despesas que não vêm de um documento/nota formal, só aparecem no extrato bancário.
- Painel/dashboard 1: soma dos pagamentos a vencer — hoje, amanhã, próximos 7 dias, próximo 1 mês.
- Painel/dashboard 2: "entradas" = **receitas esperadas** (dinheiro que vai entrar/recebimentos previstos). CONFIRMADO.
- Nota de escopo: o app não é só Contas a Pagar (saídas) — também precisa acompanhar receitas esperadas (entradas).
- CONFIRMADO: receitas também vêm de documentos (mesmo fluxo de upload/extração das contas a pagar).

### Segunda tela (NOVA)
- Resumo/dashboard visual da **distribuição dos custos** (provavelmente um gráfico ou lista mostrando o peso de cada categoria de custo — matéria prima, mão de obra, frete, folha, combustível, água, energia — dentro do total).

## Apuração de custos (feature adicional)
- App também deve ter apuração/análise de custos, separando por tipo:
  - Matéria prima (com subtipos/tipos diferentes de matéria prima)
  - Mão de obra
  - Frete
  - Folha de pagamento
  - Combustível
  - Água
  - Energia
  - (outros tipos a definir conforme o cadastro de categorias de cada empresa)
- Aba de custos mensais mostra os **totais por categoria, por mês** (ex: Folha: R$X, Combustível: R$Y, Água: R$Z, Energia: R$W, Matéria Prima: R$..., Mão de obra: R$..., Frete: R$...).
- Isso conecta com a classificação de custo por fornecedor já definida (ver seção "Classificação de custo") — a ideia é que a classificação de cada lançamento alimente relatórios de apuração de custo por categoria.
- Nota: usuário mencionou ter discutido isso antes em outra conversa ("Claudinho") — não temos acesso a esse histórico aqui, só ao que for repassado nesta conversa.
- Estrutura na planilha: além das abas mensais com o fluxo de contas a pagar (dia 1 ao 31), terá também uma **aba de custos mensais** — provavelmente um resumo/apuração consolidada dos custos do mês, quebrado por categoria (matéria prima, mão de obra, frete, etc), separada da aba de fluxo diário de contas a pagar.

## Fluxo de extração / lançamento de documentos (DETALHADO)

### Formato de entrada
- Usuário sobe um arquivo PDF que pode conter várias páginas (ex: 30 páginas), **cada página é um pagamento ou recebimento diferente** (uma nota/boleto por página).
- Serão incluídos os mais diversos tipos de arquivo/documento; a grande maioria terá a data de vencimento visível no documento.

### Como funciona o lançamento (por página/documento)
1. O programa abre o PDF e processa página por página.
2. Para cada página, faz perguntas ao usuário sobre como lançar aquela nota.
3. **Mecanismo de aprendizado**: as respostas dadas para um fornecedor ficam salvas na memória do sistema — da próxima vez que aparecer uma nota do mesmo fornecedor, o programa já sugere/lembra como essa nota costuma ser lançada e para qual categoria de custo deve ir (conecta com a regra já definida: sempre sugerir e pedir confirmação, nunca aplicar 100% automático sem checar, já que um fornecedor pode ter mais de uma categoria).

### Perguntas feitas ao lançar cada nota (fluxo inicial, pode crescer)
1. **É Fornecedor ou Cliente?**
   - Fornecedor = despesa (conecta com contas a pagar / custos)
   - Cliente = receita (conecta com "receitas esperadas")
2. **Pago ou a pagar?**
   - Se **pago**: só entra na soma dos custos (não precisa de rastreio de vencimento/pendência).
   - Se **a pagar**: incluir a(s) data(s) de vencimento que estão na nota. Se a nota não tiver data visível, perguntar ao usuário qual a data.
3. **Qual a forma de pagamento?**
   - Boleto ou Pix.
   - Se Pix: perguntar qual a chave Pix.

### Regra de automação CONFIRMADA
- O app só faz as perguntas (Fornecedor/Cliente, Pago/A pagar, forma de pagamento, categoria) **na primeira vez** que aparecer uma nota daquele fornecedor.
- Nas próximas vezes que aparecer nota do mesmo fornecedor, o lançamento é **automático**, sem perguntar de novo.
- RESOLVIDO (substitui a regra antiga de "sempre pedir confirmação"): **automático sempre, sem exceção**, a partir da segunda nota do mesmo fornecedor — mesmo em casos como o do fornecedor "Takara" (que vende máquinas E óleo lubrificante, categorias diferentes). Se a classificação vier errada por causa disso, o usuário corrige manualmente depois, ao perceber o erro na planilha. Não há verificação automática de "nota diferente do padrão" nem tela de confirmação rápida — é 100% automático após a primeira vez.

### Fluxo do lado "Cliente" (receita) — CONFIRMADO
Mais simples que o de Fornecedor: entra a nota, o app pergunta **qual a data de vencimento/recebimento prevista**. Não tem a mesma bateria de perguntas do Fornecedor (não pergunta forma de recebimento nem "recebido ou a receber" — só a data).

### Notas com múltiplos vencimentos/parcelas — CONFIRMADO
Quando uma nota tem mais de uma data de vencimento (parcelado), o software **lê todas as datas de vencimento da nota** e lança cada parcela **na linha do dia certo** na planilha (uma entrada por vencimento, cada uma no seu devido dia — não uma linha só com todas as parcelas juntas).

## Exportação / Planilha "viva"
- Estilo Google Sheets: o app fica **conectado** à planilha e atualiza automaticamente conforme os dias passam e operações são realizadas (novos lançamentos, arquivos processados, etc.) — não é um Excel estático gerado sob demanda, é uma planilha sempre atualizada em tempo real/quase real.
- Implicação técnica provável: usar Google Sheets (via API) como a "planilha viva", em vez de gerar arquivos .xlsx do zero a cada exportação.
- Estrutura definida: **1 planilha Google Sheets por empresa**, com **1 aba por mês**. Dentro de cada aba de mês, as contas a pagar aparecem em um fluxo crescente do dia 1 ao dia 31 (organizadas por dia de vencimento/lançamento ao longo do mês).

## Planilha de exemplo enviada pelo usuário (referência de layout)
Arquivo: `Planilha_Teste_Controle_Financeiro.xlsx` (recebido em 2026-09-03). Estrutura com 15 abas:
- **Janeiro..Dezembro** (12 abas mensais): título "CONTROLE DE PAGAMENTOS — [MÊS]". Colunas: Dia, Data de vencimento, Favorecido/fornecedor, Descrição, Forma de pagamento, PIX/dados bancários, Valor, Categoria do custo, Pago?, Observações. Linha final "TOTAL DO MÊS" com `=SOMA(coluna Valor)`.
- **Recebimentos**: título "CONTROLE DE RECEBIMENTOS". Colunas: Data prevista, Data recebida, Cliente/origem, Descrição, Tipo, Forma de recebimento, Conta/destino, Valor previsto, Valor recebido, Observações.
- **Classificação de Custos**: título "DESTINAÇÃO E CLASSIFICAÇÃO DOS PAGAMENTOS". Log mestre de todos os pagamentos com: Mês, Dia, Fornecedor, Descrição do pagamento, Valor, Categoria, Subcategoria, Empresa, Centro de custo, Documento/NF, Observações.
- **Listas**: valores para dropdowns — Formas de pagamento (PIX, Boleto, Transferência, Débito automático, Cartão, Dinheiro, Cheque), Categorias de custo (Matéria-prima, Mão de obra, Energia, Impostos, Fretes, Manutenção, Serviços, Softwares, Administrativo, Financeiro, Investimentos, Outros), Status (Sim/Não), Tipos de recebimento (Venda, Aporte, Empréstimo, Outros).
- **Classificação de Custos — REDESENHADA (não é mais log por transação)**: essa aba deixou de ser um log detalhado (linha por lançamento, com Fornecedor/Documento/NF etc). Virou uma **lista compilada de totais por categoria**, separada em blocos por mês (mesmo padrão visual de agrupar/recolher das abas de pagamento). Estrutura implementada:
  - Colunas: apenas **Categoria de custo** | **Valor total**.
  - 1 bloco por mês (Janeiro..Dezembro), com o nome do mês como linha "cabeçalho" sempre visível (estilo resumo, igual ao "Dia" nas abas de pagamento), e as linhas de categoria abaixo dele agrupadas/colapsáveis.
  - **1 linha por categoria de custo**, mostrando a SOMA de todos os lançamentos daquela categoria naquele mês — ex: todas as compras de "Matéria-prima - Tecidos" somadas numa linha só, toda "Energia" somada em outra, etc. Não lista lançamento por lançamento.
  - Os totais são calculados por fórmula (SOMASES) puxando da aba mensal de pagamentos correspondente (coluna Valor + coluna Categoria do custo) — não há redigitação manual, os dados-fonte continuam vivendo só nas abas mensais de pagamento.
  - Linha "Total do mês" ao final de cada bloco, somando todas as categorias (deve bater com o "TOTAL DO MÊS" da aba de pagamento daquele mês).
  - Categorias usadas no protótipo: Matéria-prima - Tecidos, Mão de obra, Frete, Folha de pagamento, Combustível, Água, Energia, Impostos, Depósitos judiciais, Serviços ambientais, Manutenção, Serviços, Softwares, Administrativo, Financeiro, Investimentos, Outros. Lembrar: essa lista é aberta/extensível (ver nota abaixo), essas são só as conhecidas até agora.
  - IMPORTANTE (limitação do protótipo em Excel estático): para a fórmula SOMASES encontrar os valores, o texto da categoria lançado na aba mensal de pagamento precisa bater exatamente com o texto da categoria nessa aba de custos. No app de verdade isso não é problema (o sistema controla os nomes de categoria centralmente, sem digitação livre / risco de erro de digitação).
  - CONFIRMADO pelo usuário: como a lista de categorias é aberta/extensível (cresce conforme o app lê notas novas — ver seção "Classificação de custo"), essa aba **vai precisar gerar novas linhas automaticamente** quando uma categoria nova surgir. Isso é responsabilidade do backend/app real (que escreve na planilha Google Sheets via API), não de edição manual.
  - RESOLVIDO: quando uma categoria nova surge (ex: em julho), ela deve aparecer em **TODOS os meses do ano, inclusive os anteriores** (ex: janeiro a junho mostram a linha dessa categoria com R$ 0,00), não só dali pra frente. Mantém a planilha com o mesmo conjunto de categorias em todo mês, facilitando comparação mês a mês. Implicação técnica: quando uma categoria nova aparece pela primeira vez, o backend precisa inserir a linha dela em TODOS os blocos de mês já existentes na planilha daquele ano (passados e futuros), não só no mês corrente em diante.
  - CONFIRMADO: essa lista de categorias de custo não é fixa/fechada. Já falta: Água, Depósitos judiciais, Serviços ambientais. Mas o importante é o mecanismo: **a lista de categorias vai crescendo organicamente conforme o app "lê" as notas** — quando aparece um tipo de despesa novo que ainda não tem categoria, o app cria a categoria na hora (não é uma lista pré-cadastrada e fechada que o admin precisa preencher tudo de antemão). Reforça o modelo já definido: cada empresa tem suas próprias categorias, e essa lista é aberta/extensível.

### Agrupamento por dia — IMPLEMENTADO
Nas abas mensais, cada dia (1 a 31) tem **30 linhas** (era 20 no exemplo original, ampliado a pedido do usuário para dar folga). As 29 linhas de detalhe de cada dia ficam **agrupadas (outline do Excel) e recolhidas por padrão**, mostrando só a 1ª linha do dia (com o número do dia) — visual compacto de 31 linhas quando tudo fechado. O usuário expande manualmente o dia que está organizando (clicando no botão "+") e recolhe quando termina.
- Entregue ao usuário uma versão de exemplo já com esse agrupamento aplicado: [Planilha_Controle_Financeiro_Agrupada.xlsx](Planilha_Controle_Financeiro_Agrupada.xlsx) (feita via automação COM do Excel, pois não há Python instalado nesta máquina — nota técnica: usar Excel COM ou manipulação direta do XML/zip do .xlsx como alternativa ao openpyxl neste ambiente).
- Essa lógica de agrupamento por dia deve valer também para a planilha "viva" do Google Sheets (replicar o mesmo padrão de 30 linhas/dia com agrupamento, usando a funcionalidade de agrupamento de linhas do Google Sheets).
