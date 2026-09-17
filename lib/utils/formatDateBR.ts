// Formato brasileiro (DD/MM/AAAA) — a planilha é pt_BR, então escrever nesse
// formato faz o Google Sheets reconhecer o valor como data de verdade (em vez
// de texto), o que é necessário pras fórmulas de resumo mensal funcionarem.
export function toBRDateString(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}
