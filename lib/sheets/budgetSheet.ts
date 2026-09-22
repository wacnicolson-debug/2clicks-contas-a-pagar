import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import {
  COST_TAB,
  BUDGET_TAB,
  buildBudgetValues,
  buildBudgetStructuralRequests,
} from "./provisionCompanySheet";

// Aba oculta que espelha a Classificação de Custos (do arquivo de Contas a
// Pagar) via IMPORTRANGE — a Orçamento (visível) lê daqui, nunca do arquivo
// de origem direto (Sheets não deixa fórmula normal referenciar outro
// arquivo — só IMPORTRANGE, e só pra uma aba de destino, por isso o espelho).
const SOURCE_TAB = "Fonte";

/**
 * Cria a planilha (arquivo SEPARADO, não uma aba) de Orçamento de UM ano —
 * clone em tempo real da Classificação de Custos via IMPORTRANGE, com
 * categorias como Folha/Impostos mostrando a média do ano em vez do valor
 * de cada mês (ver `buildBudgetValues`).
 *
 * Só precisa rodar 1 vez por ano — o IMPORTRANGE se mantém atualizado
 * sozinho depois, sem o app precisar reescrever nada na aba "Fonte" de novo.
 */
async function provisionBudgetSpreadsheet(
  companyName: string,
  googleRefreshToken: string,
  year: number,
  sourceSpreadsheetId: string
): Promise<string> {
  const { sheets } = getGoogleClientsForCompany(googleRefreshToken);

  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Orçamento — ${companyName} — ${year}`, locale: "pt_BR" },
      sheets: [{ properties: { title: SOURCE_TAB } }, { properties: { title: BUDGET_TAB } }],
    },
  });
  const spreadsheetId = createRes.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Falha ao criar a planilha de Orçamento.");

  const sourceSheetId = createRes.data.sheets?.find(
    (s) => s.properties?.title === SOURCE_TAB
  )?.properties?.sheetId;

  // 1 fórmula só, espelha a aba inteira (2000 linhas é folga generosa —
  // a Classificação de Custos cresce por categoria, não deve chegar perto).
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SOURCE_TAB}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[`=IMPORTRANGE("${sourceSpreadsheetId}"; "'${COST_TAB}'!A1:B2000")`]],
    },
  });

  if (sourceSheetId !== undefined && sourceSheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: sourceSheetId, hidden: true },
              fields: "hidden",
            },
          },
        ],
      },
    });
  }

  return spreadsheetId;
}

/**
 * Devolve o spreadsheetId da planilha de Orçamento de UM ano — criando na
 * hora se ainda não existir (mesma ideia do `getOrCreateCompanySheetForYear`,
 * mas o "ano" aqui é o mesmo da planilha de Contas a Pagar que ela clona).
 */
export async function getOrCreateBudgetSheetForYear(
  companyId: string,
  year: number
): Promise<string> {
  const companySheet = await prisma.companySheet.findUniqueOrThrow({
    where: { companyId_year: { companyId, year } },
  });
  if (companySheet.budgetSpreadsheetId) return companySheet.budgetSpreadsheetId;

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!company.googleRefreshToken) {
    throw new Error(`Empresa ${companyId} ainda não conectou o Google Sheets.`);
  }

  const spreadsheetId = await provisionBudgetSpreadsheet(
    company.name,
    company.googleRefreshToken,
    year,
    companySheet.spreadsheetId
  );

  const saved = await prisma.companySheet.update({
    where: { companyId_year: { companyId, year } },
    data: { budgetSpreadsheetId: spreadsheetId },
  });

  return saved.budgetSpreadsheetId!;
}

/**
 * Reconstrói do zero a aba "Orçamento" (delete+recreate, mesmo padrão de
 * `rebuildCostSummaryTab`) — SÓ a aba visível, dentro do arquivo separado de
 * Orçamento. Precisa rodar sempre que a lista de categorias muda (nova
 * categoria, ou `budgetSmoothed` de alguma mudou) — os VALORES em si já se
 * atualizam sozinhos via IMPORTRANGE, isso aqui só corrige a ESTRUTURA
 * (quais categorias existem e em qual linha).
 */
export async function rebuildBudgetTab(companyId: string, year: number): Promise<void> {
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId, year } },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!companySheet || !company.googleRefreshToken) return; // planilha desse ano ainda não existe

  const categories = await prisma.category.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: { name: true, budgetSmoothed: true },
  });
  if (categories.length === 0) return;

  const budgetSpreadsheetId = await getOrCreateBudgetSheetForYear(companyId, year);
  const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: budgetSpreadsheetId });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === BUDGET_TAB);
  const oldSheetId = existing?.properties?.sheetId;
  const index = existing?.properties?.index;

  // Este arquivo só tem 2 abas (a "Fonte" oculta e esta) — apagar a "Orçamento"
  // antes de criar a nova deixaria, por um instante, zero abas visíveis (o
  // Sheets recusa isso), e criar a nova já com o nome "Orçamento" antes de
  // apagar a velha esbarraria em nome duplicado. Por isso: cria com nome
  // temporário, apaga a velha, só então renomeia — tudo no mesmo batch.
  const tempTitle = `${BUDGET_TAB} (novo)`;
  const addRenameDelete = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: budgetSpreadsheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: tempTitle, index: index ?? undefined } } },
        ...(oldSheetId !== undefined && oldSheetId !== null
          ? [{ deleteSheet: { sheetId: oldSheetId } }]
          : []),
      ],
    },
  });

  const newSheetId = addRenameDelete.data.replies?.find((r) => r.addSheet)?.addSheet?.properties
    ?.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error("Falha ao recriar a aba de Orçamento.");
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: budgetSpreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: newSheetId, title: BUDGET_TAB },
            fields: "title",
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: budgetSpreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [buildBudgetValues(categories, SOURCE_TAB)],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: budgetSpreadsheetId,
    requestBody: {
      requests: buildBudgetStructuralRequests(newSheetId, categories),
    },
  });
}
