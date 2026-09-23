"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 15000;

// Atualiza a página sozinha (re-busca os dados do servidor, sem recarregar
// tudo) — pra lançamentos/respostas pendentes novos aparecerem sem precisar
// de F5 manual.
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), INTERVAL_MS);
    return () => clearInterval(interval);
  }, [router]);

  return null;
}
