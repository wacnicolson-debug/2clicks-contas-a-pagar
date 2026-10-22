// Observação escolhida na tela de envio: vale pra TODOS os lançamentos que saírem daquele envio, pra
// não precisar marcar um a um (a Distribuição de custos separa por empresa pela observação).
export const UPLOAD_OBSERVATIONS = [
  { value: "MRC", label: "MRC" },
  { value: "SANTA LUZIA", label: "Santa Luzia" },
] as const;

/** Só aceita uma das opções da lista (texto livre vindo da rede nunca vira observação). */
export function parseUploadObservation(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return UPLOAD_OBSERVATIONS.find((o) => o.value === raw.trim())?.value ?? null;
}
