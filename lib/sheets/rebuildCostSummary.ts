import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import {
  COST_TAB,
  buildCostSummaryValues,
  buildCostSummaryStructuralRequests,
} from "./provisionCompanySheet";

/**
 * Reconstrói do zero a aba "Classificação de Custos" (da planilha de UM ano
 * específico) com a lista de categorias ATUAL da empresa — a lista é aberta,
 * cresce sozinha conforme o app encontra categorias novas ao ler notas.
 *
 * A aba não guarda nenhum dado digitado pelo usuário (só nome de categoria +
 * fórmula), então apagar e recriar do zero é seguro — evita o trabalho bem
 * mais arriscado de inserir linha por linha nos 12 blocos de mês já existentes.
 */
export async function rebuildCostSummaryTab(companyId: string, year: number): Promise<void> {
  const companySheet = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId, year } },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!companySheet || !company.googleRefreshToken) return; // planilha desse ano ainda não existe

  const categories = await prisma.category.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
  });
  const categoryNames = categories.map((c) => c.name);
  if (categoryNames.length === 0) return;

  const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
  const spreadsheetId = companySheet.spreadsheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === COST_TAB);
  const oldSheetId = existing?.properties?.sheetId;
  const index = existing?.properties?.index;

  const deleteAndAdd = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...(oldSheetId !== undefined && oldSheetId !== null
          ? [{ deleteSheet: { sheetId: oldSheetId } }]
          : []),
        { addSheet: { properties: { title: COST_TAB, index: index ?? undefined } } },
      ],
    },
  });

  const newSheetId = deleteAndAdd.data.replies?.find((r) => r.addSheet)?.addSheet?.properties
    ?.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error("Falha ao recriar a aba de Classificação de Custos.");
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [buildCostSummaryValues(categoryNames)],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: buildCostSummaryStructuralRequests(newSheetId, categoryNames),
    },
  });
}
