import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { normalizeText } from "@/lib/utils/normalizeText";

type Tx = { id: string; dueDate: Date; sheetCellRef: string | null; supplierName: string };

// Quem marca "pago" é a caixinha da PLANILHA (PAGO, ou CONCILIADO quando o extrato já
// bateu) — o app não guarda essa marca. Pra o painel não somar o que já foi pago, lê as
// caixinhas das linhas dos lançamentos. Resultado guardado por alguns segundos pra o
// painel não gastar a cota de leitura do Google a cada recarga.
const CACHE_MS = 20 * 1000;
const cache = new Map<string, { at: number; paid: Set<string>; key: string }>();

function findCol(header: unknown[], ...names: string[]): number {
  return header.findIndex((c) => names.includes(String(c ?? "").trim().toUpperCase()));
}

/** Ids dos lançamentos cuja linha na planilha está marcada como paga (PAGO ou CONCILIADO). */
export async function idsMarkedPaidInSheet(companyId: string, txs: Tx[]): Promise<Set<string>> {
  const withRef = txs.filter((t) => t.sheetCellRef);
  if (withRef.length === 0) return new Set();
  const key = withRef.map((t) => t.id).join(",");
  const hit = cache.get(companyId);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.paid;

  const paid = new Set<string>();
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { sheets: true } });
    if (!company?.googleRefreshToken) return paid;
    const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);

    // agrupa por planilha (ano) e aba
    const groups = new Map<string, { spreadsheetId: string; tab: string; list: Tx[] }>();
    for (const t of withRef) {
      const sheet = company.sheets.find((s) => s.year === t.dueDate.getUTCFullYear());
      const tab = t.sheetCellRef!.split("!")[0];
      if (!sheet || tab === "Custos Pagos" || tab === "Recebimentos") continue;
      const k = `${sheet.spreadsheetId}|${tab}`;
      groups.set(k, { spreadsheetId: sheet.spreadsheetId, tab, list: [...(groups.get(k)?.list ?? []), t] });
    }

    for (const g of groups.values()) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: g.spreadsheetId,
        range: `'${g.tab}'!A1:Z1300`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const rows = (res.data.values ?? []) as unknown[][];
      const header = rows[1] ?? [];
      const pagoCol = findCol(header, "PAGO");
      const conciliadoCol = findCol(header, "CONCILIADO");
      const supplierCol = header.findIndex((c) => /favorecido/i.test(String(c ?? "")));
      if (supplierCol < 0 || (pagoCol < 0 && conciliadoCol < 0)) continue;
      for (const t of g.list) {
        const row = Number(t.sheetCellRef!.split("!")[1]?.match(/\d+/)?.[0]);
        const cells = rows[row - 1];
        if (!cells) continue;
        // confere que a linha ainda é desse lançamento (a posição guardada pode ter ficado velha)
        if (normalizeText(String(cells[supplierCol] ?? "")) !== normalizeText(t.supplierName)) continue;
        if ((pagoCol >= 0 && cells[pagoCol] === true) || (conciliadoCol >= 0 && cells[conciliadoCol] === true)) paid.add(t.id);
      }
    }
  } catch (err) {
    console.error("Não consegui ler as caixinhas de pago da planilha pro painel:", err);
    return new Set();
  }
  cache.set(companyId, { at: Date.now(), paid, key });
  return paid;
}
