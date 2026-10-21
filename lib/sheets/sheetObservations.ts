import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import { MONTHS } from "./provisionCompanySheet";
import { cellToNumber, findDayColumnOffset, validDay } from "./dayBlockLayout";
import { normalizeText } from "@/lib/utils/normalizeText";

// A observação (coluna Observações) digitada direto na planilha vale pro app: a Distribuição de
// custos separa MRC / Santa Luzia / Lenha pela observação guardada no banco, então o que foi
// digitado na planilha é copiado pra lá. Só leitura da planilha — nada é escrito nela.
//
// Regras de segurança:
//  - a linha é achada pelo CONTEÚDO (dia + fornecedor + valor), nunca só pela posição;
//  - se a linha não casa com exatamente 1 lançamento, é ignorada;
//  - célula vazia nunca apaga a observação do banco (pra limpar, use Editar no app);
//  - roda no máximo a cada 45 s por empresa (cota de leitura do Google).
const THROTTLE_MS = 45 * 1000;
const lastRun = new Map<string, number>();
const running = new Set<string>();

const OBSERVATION_OFFSET = 8; // a partir da coluna Dia: Dia, Data, Favorecido, -, Forma, PIX, Valor, Categoria, Observações

export type ObservationChange = {
  id: string;
  year: number;
  tab: string;
  day: number;
  supplier: string;
  amount: number;
  from: string | null;
  to: string;
};

export async function syncObservationsFromSheet(
  companyId: string,
  options?: { apply?: boolean; force?: boolean }
): Promise<ObservationChange[]> {
  const apply = options?.apply ?? true;
  if (running.has(companyId)) return [];
  const last = lastRun.get(companyId);
  if (!options?.force && last && Date.now() - last < THROTTLE_MS) return [];
  running.add(companyId);
  lastRun.set(companyId, Date.now());

  try {
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { sheets: true } });
    if (!company?.googleRefreshToken || company.sheets.length === 0) return [];
    const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
    const changes: ObservationChange[] = [];

    for (const cs of company.sheets) {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: cs.spreadsheetId,
        ranges: MONTHS.map((m) => `'${m}'!A2:N1500`),
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const txs = await prisma.transaction.findMany({
        where: { companyId, kind: "PAYABLE", dueDate: { gte: new Date(Date.UTC(cs.year, 0, 1)), lt: new Date(Date.UTC(cs.year + 1, 0, 1)) } },
        select: { id: true, dueDate: true, amount: true, description: true, supplier: { select: { name: true } } },
      });
      const byDay = new Map<string, typeof txs>();
      for (const t of txs) {
        const key = `${t.dueDate.getUTCMonth()}-${t.dueDate.getUTCDate()}`;
        byDay.set(key, [...(byDay.get(key) ?? []), t]);
      }

      const seen = new Set<string>();
      MONTHS.forEach((tab, monthIndex) => {
        const values = (res.data.valueRanges?.[monthIndex]?.values ?? []) as unknown[][];
        const offset = findDayColumnOffset(values[0]);
        for (const row of values.slice(1)) {
          const day = validDay(row?.[offset]);
          const name = String(row?.[offset + 2] ?? "").trim();
          const amount = cellToNumber(row?.[offset + 6]);
          const observation = String(row?.[offset + OBSERVATION_OFFSET] ?? "").trim();
          if (day === null || !name || amount === null || !observation) continue;

          const wanted = normalizeText(name);
          const matches = (byDay.get(`${monthIndex}-${day}`) ?? []).filter(
            (t) => normalizeText(t.supplier.name) === wanted && Math.abs(Number(t.amount) - amount) < 0.005
          );
          if (matches.length !== 1) continue;
          const t = matches[0];
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          if ((t.description ?? "").trim() === observation) continue;
          changes.push({ id: t.id, year: cs.year, tab, day, supplier: t.supplier.name, amount, from: t.description, to: observation });
        }
      });
    }

    if (apply) {
      for (const c of changes) {
        await prisma.transaction.update({ where: { id: c.id }, data: { description: c.to } });
      }
    }
    return changes;
  } catch (err) {
    console.error("Não consegui copiar as observações da planilha pro app:", err);
    return [];
  } finally {
    running.delete(companyId);
  }
}
