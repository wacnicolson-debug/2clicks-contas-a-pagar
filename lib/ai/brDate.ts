// A IA copia a data exatamente como está impressa ("09/10/2026") e quem
// converte é este código, sempre como dia/mês/ano. Antes a própria IA
// convertia pra AAAA-MM-DD e às vezes trocava dia e mês (09/10 virava 10/09),
// lançando uma parcela fantasma num mês errado sem ninguém perceber.

/** "09/10/2026", "9.10.26", "09-10-2026" → "2026-10-09". null se não for uma data real. */
export function parseBrDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})(?!\d)/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatBrDate(iso: string): string {
  return iso.split("-").reverse().join("/");
}

function parcelOrder(parcelNumber: string | null | undefined): number | null {
  const match = parcelNumber?.match(/^\D*0*(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Regras que não dependem da IA pra desconfiar de uma data: duas parcelas no
 * mesmo dia, vencimentos que não sobem junto com o número da parcela (1/7,
 * 2/7...), ou parcela vencendo antes da emissão da nota. Cada problema vira
 * um motivo pra parar e perguntar, em vez de lançar calado.
 */
export function installmentDateProblems(
  installments: { dueDate: string | null; parcelNumber?: string | null }[],
  issueDate: string | null
): string[] {
  const problems: string[] = [];
  const dated = installments.filter((i): i is typeof i & { dueDate: string } => !!i.dueDate);

  const seen = new Set<string>();
  for (const i of dated) {
    if (seen.has(i.dueDate)) {
      problems.push(`Duas parcelas com o mesmo vencimento (${formatBrDate(i.dueDate)}).`);
      break;
    }
    seen.add(i.dueDate);
  }

  const numbered = dated.map((i) => ({ ...i, order: parcelOrder(i.parcelNumber) }));
  const allNumbered =
    numbered.length > 1 &&
    numbered.every((i) => i.order !== null) &&
    new Set(numbered.map((i) => i.order)).size === numbered.length;
  if (allNumbered) {
    const byParcel = [...numbered].sort((a, b) => a.order! - b.order!);
    for (let k = 1; k < byParcel.length; k++) {
      if (byParcel[k].dueDate <= byParcel[k - 1].dueDate) {
        problems.push(
          `A parcela ${byParcel[k].parcelNumber} vence em ${formatBrDate(byParcel[k].dueDate)}, antes ou junto da parcela ${byParcel[k - 1].parcelNumber} (${formatBrDate(byParcel[k - 1].dueDate)}) — provável dia e mês trocados.`
        );
        break;
      }
    }
  }

  if (issueDate) {
    const early = dated.find((i) => i.dueDate < issueDate);
    if (early) {
      problems.push(
        `Parcela vencendo em ${formatBrDate(early.dueDate)}, antes da emissão da nota (${formatBrDate(issueDate)}).`
      );
    }
  }

  return problems;
}
