import { getGoogleClientsForCompany } from "./client";
import {
  RECEBIMENTOS_TAB,
  buildRecebimentosSummaryValues,
  buildRecebimentosSummaryStructuralRequests,
} from "./provisionCompanySheet";

function isoToBR(value: string | undefined): string {
  const raw = (value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

/**
 * Corrige uma planilha de empresa já existente, criada antes do resumo
 * mensal/datas em padrão BR existirem: reformata as datas já gravadas na
 * aba Recebimentos (ISO -> DD/MM/AAAA — senão o SUMIFS do resumo não
 * reconhece como data) e adiciona/atualiza o bloco de resumo mensal em L:M.
 * Planilhas novas já nascem certas (ver provisionCompanySheet.ts) — isso é
 * só pra acertar o que já foi criado antes dessa mudança.
 */
export async function backfillRecebimentosForCompanySheet(params: {
  spreadsheetId: string;
  year: number;
  googleRefreshToken: string;
}): Promise<{ datesFixed: boolean }> {
  const { sheets } = getGoogleClientsForCompany(params.googleRefreshToken);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: params.spreadsheetId });
  const tab = meta.data.sheets?.find((s) => s.properties?.title === RECEBIMENTOS_TAB);
  if (!tab || tab.properties?.sheetId == null) {
    return { datesFixed: false };
  }
  const sheetId = tab.properties.sheetId;

  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: params.spreadsheetId,
    range: `'${RECEBIMENTOS_TAB}'!A3:B100000`,
  });
  const rows = current.data.values ?? [];
  const fixedRows = rows.map((row) => [isoToBR(row[0]), isoToBR(row[1])]);
  const datesFixed = fixedRows.some(
    (row, i) => row[0] !== (rows[i][0] ?? "") || row[1] !== (rows[i][1] ?? "")
  );

  if (datesFixed && fixedRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: params.spreadsheetId,
      range: `'${RECEBIMENTOS_TAB}'!A3:B${2 + fixedRows.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: fixedRows },
    });
  }

  const summary = buildRecebimentosSummaryValues(params.year);
  await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: summary.range!,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: summary.values },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: params.spreadsheetId,
    requestBody: { requests: buildRecebimentosSummaryStructuralRequests(sheetId) },
  });

  return { datesFixed };
}
