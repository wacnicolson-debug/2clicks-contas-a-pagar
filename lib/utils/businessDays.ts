// Vencimento em domingo ou feriado passa pro próximo dia que não seja nenhum
// dos dois (domingo -> segunda). Sábado NÃO é pulado: a empresa paga no sábado
// (a semana da planilha vai de sábado a sexta). Só vale pra contas a pagar.
//
// Feriados: nacionais fixos, Carnaval (segunda e terça), Sexta-feira Santa e
// Corpus Christi (dias sem expediente bancário) e 31/12 (também sem expediente
// bancário). Feriado estadual/municipal NÃO está aqui — corrige-se em Editar.

const FIXED_HOLIDAYS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Consciência Negra",
  "12-25": "Natal",
  "12-31": "sem expediente bancário",
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/** Domingo de Páscoa (algoritmo gregoriano anônimo). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Feriados do ano: AAAA-MM-DD -> nome. */
export function brazilianHolidays(year: number): Map<string, string> {
  const holidays = new Map<string, string>();
  for (const [mmdd, name] of Object.entries(FIXED_HOLIDAYS)) {
    holidays.set(`${year}-${mmdd}`, name);
  }
  const easter = easterSunday(year);
  holidays.set(toIso(addDays(easter, -48)), "Carnaval");
  holidays.set(toIso(addDays(easter, -47)), "Carnaval");
  holidays.set(toIso(addDays(easter, -2)), "Sexta-feira Santa");
  holidays.set(toIso(addDays(easter, 60)), "Corpus Christi");
  return holidays;
}

function reasonIfNonBusiness(iso: string): string | null {
  const match = ISO.exec(iso);
  if (!match) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const holiday = brazilianHolidays(Number(match[1])).get(iso);
  if (holiday) return holiday === "sem expediente bancário" ? holiday : `feriado: ${holiday}`;
  if (date.getUTCDay() === 0) return "domingo";
  return null;
}

/**
 * Se `iso` (AAAA-MM-DD) cai em domingo ou feriado, devolve o próximo dia que
 * não seja nenhum dos dois, e uma nota com o vencimento original (pra conferir
 * com o papel). Data fora do formato volta como veio, sem nota.
 */
export function adjustDueDate(iso: string): { date: string; note: string | null } {
  const reason = reasonIfNonBusiness(iso);
  if (!reason) return { date: iso, note: null };

  let current = new Date(`${iso}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    current = addDays(current, 1);
    if (!reasonIfNonBusiness(toIso(current))) break;
  }
  const [y, m, d] = iso.split("-");
  return { date: toIso(current), note: `Venc. original ${d}/${m}/${y} (${reason})` };
}

const NOTE_PATTERN = /Venc\. original \d{2}\/\d{2}\/\d{4} \([^)]*\)/;

/** Junta a observação do usuário com a nota de ajuste de vencimento, se houver. */
export function withAdjustNote(userText: string | null | undefined, note: string | null): string | null {
  const parts = [userText?.trim(), note].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" — ") : null;
}

/** Tira uma nota de ajuste antiga de uma observação (ao copiar um lançamento pra outro mês). */
export function stripAdjustNote(text: string | null | undefined): string | null {
  const cleaned = (text ?? "")
    .replace(NOTE_PATTERN, "")
    .replace(/^\s*—\s*|\s*—\s*$/g, "")
    .trim();
  return cleaned || null;
}
