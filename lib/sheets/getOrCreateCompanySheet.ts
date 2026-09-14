import { prisma } from "@/lib/db/prisma";
import { provisionCompanySheet } from "./provisionCompanySheet";

/**
 * Devolve o spreadsheetId da planilha da empresa PARA UM ANO específico —
 * criando essa planilha na hora, sozinho, se ainda não existir (é assim que
 * a virada de ano é resolvida: sem trabalho manual nenhum).
 */
export async function getOrCreateCompanySheetForYear(
  companyId: string,
  year: number
): Promise<string> {
  const existing = await prisma.companySheet.findUnique({
    where: { companyId_year: { companyId, year } },
  });
  if (existing) return existing.spreadsheetId;

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!company.googleRefreshToken) {
    throw new Error(`Empresa ${companyId} ainda não conectou o Google Sheets.`);
  }

  const { spreadsheetId } = await provisionCompanySheet(
    company.name,
    company.googleRefreshToken,
    year
  );

  // upsert em vez de create puro: protege contra duas chamadas concorrentes
  // tentando criar a planilha do mesmo ano ao mesmo tempo.
  const saved = await prisma.companySheet.upsert({
    where: { companyId_year: { companyId, year } },
    update: {},
    create: { companyId, year, spreadsheetId },
  });

  return saved.spreadsheetId;
}
