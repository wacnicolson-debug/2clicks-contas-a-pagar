// A IA às vezes devolve uma data com lixo colado (ex: "2026-09-25}", um
// resquício de streaming/parsing) — isso passa qualquer checagem de "tem
// data" (o campo não é vazio) mas dá "Invalid Date" na hora de exibir/gravar,
// sem nunca pedir pra corrigir. Trata qualquer data fora do formato
// AAAA-MM-DD (ou que não seja uma data real) como null, igual a "não achou
// data" — cada fluxo já sabe lidar com isso (pede a data ou marca como órfã).
export function sanitizeIsoDate(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return Number.isNaN(new Date(`${date}T00:00:00`).getTime()) ? null : date;
}
