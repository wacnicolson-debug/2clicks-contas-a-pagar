import type { Prisma } from "@prisma/client";

export const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const QUARTER_LABELS = ["1º trimestre", "2º trimestre", "3º trimestre", "4º trimestre"];

export type Period = "mes" | "trimestre" | "ano";
export type DateBase = "pagamento" | "entrada";

export function parsePeriod(v: string | string[] | undefined): Period {
  return v === "trimestre" || v === "ano" ? v : "mes";
}

export function parseBase(v: string | string[] | undefined): DateBase {
  return v === "entrada" ? "entrada" : "pagamento";
}

export function getRange(period: Period, now: Date): { start: Date; end: Date; label: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (period === "ano") {
    return {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year + 1, 0, 1)),
      label: `Ano de ${year}`,
    };
  }

  if (period === "trimestre") {
    const quarterIndex = Math.floor(month / 3);
    return {
      start: new Date(Date.UTC(year, quarterIndex * 3, 1)),
      end: new Date(Date.UTC(year, quarterIndex * 3 + 3, 1)),
      label: `${QUARTER_LABELS[quarterIndex]} de ${year}`,
    };
  }

  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
    label: `${MONTH_NAMES[month]} de ${year}`,
  };
}

/**
 * Quais lançamentos entram na Distribuição de custos de um período. Usado pela
 * tela de totais e pela de detalhe (a lista tem que somar exatamente o mesmo).
 *
 * Data de entrada = quando o custo realmente aconteceu: a "Data da nota"
 * (noteDate), quando preenchida (nota antiga lançada com atraso), senão o
 * vencimento — MESMA regra de "costDate" usada em syncTransaction.ts e na
 * Classificação de Custos. NUNCA "createdAt" (quando foi digitado no sistema).
 */
export function costWhere(companyId: string, base: DateBase, start: Date, end: Date): Prisma.TransactionWhereInput {
  return {
    companyId,
    kind: "PAYABLE",
    ...(base === "entrada"
      ? {
          OR: [
            { noteDate: { gte: start, lt: end } },
            { noteDate: null, dueDate: { gte: start, lt: end } },
          ],
        }
      : { dueDate: { gte: start, lt: end } }),
  };
}

/** Data de referência (dia dentro do período) vinda da URL, ou hoje. */
export function referenceDate(param: string | string[] | undefined): { now: Date; refDateParam: string | null } {
  const refDateParam = typeof param === "string" ? param : null;
  return { now: refDateParam ? new Date(refDateParam + "T00:00:00Z") : new Date(), refDateParam };
}
