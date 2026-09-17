import { getGoogleClientsForCompany } from "./client";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoToBR(value: string): string {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return value;
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

/**
 * Reformata a coluna "Data de vencimento" (B) de uma aba de mês (Contas a
 * Pagar) que ainda tenha datas em ISO (AAAA-MM-DD) — escritas antes da
 * correção pro padrão BR — sem mexer em nenhuma outra coluna nem linha
 * (a posição de cada lançamento não muda, só o texto da data).
 */
export async function fixMonthTabDatesToBR(params: {
  spreadsheetId: string;
  monthName: string;
  googleRefreshToken: string;
}): Promise<{ changed: number }> {
  const { sheets } = getGoogleClientsForCompany(params.googleRefreshToken);

  const range = `'${params.monthName}'!B3:B1000`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId: params.spreadsheetId, range });
  const rows = current.data.values ?? [];
  if (rows.length === 0) return { changed: 0 };

  let changed = 0;
  const fixed = rows.map((row) => {
    const value = row[0] ?? "";
    const br = isoToBR(value);
    if (br !== value) changed++;
    return [br];
  });

  if (changed > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: params.spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: fixed },
    });
  }

  return { changed };
}
