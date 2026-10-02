import { prisma } from "@/lib/db/prisma";
import { formatBrDate } from "@/lib/ai/brDate";
import type { ExtractedInstallment } from "@/lib/ai/extractDocument";

/** "000.074.367" e "74367" são a mesma nota. */
export function noteKey(noteNumber: string | null | undefined): string | null {
  const digits = (noteNumber ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || null;
}

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Compara uma nota recém-lida com o que já está lançado — pelo fornecedor OU
 * pelo número da nota (a IA pode ter errado o fornecedor, como nas notas da
 * TEAR que caíram na GLM).
 *
 * - allLaunched: todas as parcelas já existem (mesma data e valor) → é a
 *   mesma nota reenviada; não lança nem pergunta nada.
 * - conflicts: a nota já tem parcela lançada com o mesmo valor mas outra
 *   data, e esta leitura traz uma data que não bate com nada — uma das duas
 *   leituras trocou a data (ex: 09/10 x 10/09). Lançar criaria uma parcela a
 *   mais, então pergunta qual está certa.
 */
export async function compareWithExistingLaunches(params: {
  companyId: string;
  supplierId: string;
  noteNumber: string | null;
  installments: ExtractedInstallment[];
}): Promise<{ allLaunched: boolean; conflicts: string[] }> {
  const key = noteKey(params.noteNumber);
  const dated = params.installments.filter((i): i is ExtractedInstallment & { dueDate: string } => !!i.dueDate);
  if (dated.length === 0) return { allLaunched: false, conflicts: [] };

  const candidates = (
    await prisma.transaction.findMany({
      where: { companyId: params.companyId, amount: { in: dated.map((i) => i.amount) } },
      select: { supplierId: true, noteNumber: true, amount: true, dueDate: true },
    })
  ).filter((t) => t.supplierId === params.supplierId || (key && noteKey(t.noteNumber) === key));

  const sameAmount = (t: (typeof candidates)[number], amount: number) =>
    Math.abs(Number(t.amount) - amount) < 0.005;
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  const unmatched = dated.filter(
    (i) => !candidates.some((t) => sameAmount(t, i.amount) && isoDate(t.dueDate) === i.dueDate)
  );
  const allLaunched =
    unmatched.length === 0 && dated.length === params.installments.length;

  const conflicts: string[] = [];
  if (key) {
    const pageDates = new Set(dated.map((i) => i.dueDate));
    for (const i of unmatched) {
      const other = candidates.find(
        (t) => noteKey(t.noteNumber) === key && sameAmount(t, i.amount) && !pageDates.has(isoDate(t.dueDate))
      );
      if (other) {
        conflicts.push(
          `A nota ${params.noteNumber} já tem uma parcela de ${brl(i.amount)} lançada com vencimento ${formatBrDate(isoDate(other.dueDate))}, mas esta leitura diz ${formatBrDate(i.dueDate)}. Confira no papel qual data está certa — se for a nova, exclua o lançamento antigo em Lançamentos.`
        );
      }
    }
  }

  return { allLaunched, conflicts };
}
