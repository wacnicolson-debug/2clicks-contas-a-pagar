# 2 Clicks Contas a Pagar

SaaS multi-empresa de contas a pagar e a receber. Contexto completo do produto em [contexto-projeto.md](./contexto-projeto.md); plano técnico da Fase 1 (MVP) em `C:\Users\Walter\.claude\plans\polished-watching-rivest.md`.

## Pré-requisitos

- Node.js (já instalado nesta máquina)
- Uma conta no [Supabase](https://supabase.com) (banco de dados + armazenamento de arquivos)
- Uma chave de API da [Anthropic](https://console.anthropic.com) (leitura dos documentos por IA)
- Um projeto no [Google Cloud](https://console.cloud.google.com) com a API do Google Sheets ativada e uma conta de serviço (planilha viva)

## Configuração

1. Copie `.env.example` para `.env` e preencha cada valor (instruções dentro do próprio arquivo).
2. Instale as dependências (só precisa rodar de novo se `package.json` mudar):
   ```bash
   npm install
   ```
3. Crie as tabelas no banco de dados:
   ```bash
   npx prisma migrate dev --name init
   ```
4. Rode o script de dados iniciais (cria 1 empresa de teste, 1 usuário `admin`, as categorias padrão, e — se as credenciais do Google já estiverem configuradas — provisiona a planilha):
   ```bash
   npm run db:seed
   ```
5. Suba o servidor:
   ```bash
   npm run dev
   ```
   Abra [http://localhost:3000](http://localhost:3000) — login: `admin`, senha: `123456` (ou o que estiver em `SEED_USER_PASSWORD`).

## Processamento em segundo plano (Inngest)

A leitura de documentos roda via Inngest. Em desenvolvimento, rode em outro terminal:

```bash
npx inngest-cli@latest dev
```

Isso abre um painel local (normalmente em http://localhost:8288) mostrando os documentos sendo processados.

## Estrutura

- `app/(auth)/login` — tela de login
- `app/(dashboard)` — tela principal e fluxo de documentos
- `lib/ai/extractDocument.ts` — leitura dos documentos pela IA (Anthropic)
- `lib/sheets/provisionCompanySheet.ts` — cria a planilha Google Sheets de uma empresa do zero (agrupamento por dia, aba de custos)
- `lib/sheets/syncTransaction.ts` — mantém a planilha sincronizada a cada lançamento
- `lib/inngest/functions/processDocument.ts` — a fila que processa um documento enviado, ponta a ponta
- `prisma/schema.prisma` — modelo do banco de dados

## O que falta (fora do escopo da Fase 1)

Ver "Fora do escopo desta fase" no plano técnico: conciliação de extrato bancário, modo offline, tela de distribuição de custos, categoria nova retroativa em todos os meses, múltiplas parcelas, fluxo completo do Cliente.
