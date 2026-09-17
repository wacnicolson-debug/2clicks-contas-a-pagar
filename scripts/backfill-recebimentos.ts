// Migração pontual (roda uma vez): as planilhas de empresa já criadas antes
// do resumo mensal/datas em padrão BR existirem precisam ser atualizadas —
// planilhas novas já nascem certas (ver provisionCompanySheet.ts). Reformata
// as datas já gravadas na aba Recebimentos (ISO -> DD/MM/AAAA, senão as
// fórmulas de SUMIFS do resumo não reconhecem como data) e adiciona/atualiza
// o bloco de resumo mensal em L:M.
import "dotenv/config";
import { prisma } from "../lib/db/prisma";
import { getGoogleClientsForCompany } from "../lib/sheets/client";
import {
  RECEBIMENTOS_TAB,
  buildRecebimentosSummaryValues,
  buildRecebimentosSummaryStructuralRequests,
} from "../lib/sheets/provisionCompanySheet";

function isoToBR(value: string | undefined): string {
  const raw = (value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

async function main() {
  const companySheets = await prisma.companySheet.findMany({ include: { company: true } });

  for (const companySheet of companySheets) {
    const token = companySheet.company.googleRefreshToken;
    if (!token) continue;

    const { sheets } = getGoogleClientsForCompany(token);

    const meta = await sheets.spreadsheets.get({ spreadsheetId: companySheet.spreadsheetId });
    const tab = meta.data.sheets?.find((s) => s.properties?.title === RECEBIMENTOS_TAB);
    if (!tab || tab.properties?.sheetId == null) {
      console.log(`Sem aba "${RECEBIMENTOS_TAB}" em ${companySheet.spreadsheetId} (${companySheet.year}) — pulando.`);
      continue;
    }
    const sheetId = tab.properties.sheetId;

    const current = await sheets.spreadsheets.values.get({
      spreadsheetId: companySheet.spreadsheetId,
      range: `'${RECEBIMENTOS_TAB}'!A3:B100000`,
    });
    const rows = current.data.values ?? [];
    const fixedRows = rows.map((row) => [isoToBR(row[0]), isoToBR(row[1])]);
    const anyChanged = fixedRows.some((row, i) => row[0] !== (rows[i][0] ?? "") || row[1] !== (rows[i][1] ?? ""));

    if (anyChanged && fixedRows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: companySheet.spreadsheetId,
        range: `'${RECEBIMENTOS_TAB}'!A3:B${2 + fixedRows.length}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: fixedRows },
      });
      console.log(`Datas corrigidas para DD/MM/AAAA — empresa ${companySheet.companyId}, ano ${companySheet.year}.`);
    }

    const summary = buildRecebimentosSummaryValues(companySheet.year);
    await sheets.spreadsheets.values.update({
      spreadsheetId: companySheet.spreadsheetId,
      range: summary.range!,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: summary.values },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: companySheet.spreadsheetId,
      requestBody: { requests: buildRecebimentosSummaryStructuralRequests(sheetId) },
    });
    console.log(`Resumo mensal de vendas adicionado — empresa ${companySheet.companyId}, ano ${companySheet.year}.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
