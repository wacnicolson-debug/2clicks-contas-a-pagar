// O Google limita a ~60 leituras (e 60 gravações) por minuto por usuário. Quando estoura, o erro
// vem como 429 / "Quota exceeded": esperar uns segundos e tentar de novo resolve quase sempre.
const WAITS_MS = [7000, 14000];

function isQuotaError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string } | null;
  return e?.code === 429 || e?.status === 429 || /quota exceeded|rate limit|too many requests/i.test(e?.message ?? "");
}

export async function withQuotaRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= WAITS_MS.length || !isQuotaError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, WAITS_MS[attempt]));
    }
  }
}
