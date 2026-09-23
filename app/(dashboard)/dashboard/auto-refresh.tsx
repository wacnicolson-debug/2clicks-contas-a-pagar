"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 15000;

// Atualiza o painel sozinho (re-busca os dados do servidor, sem recarregar a
// página) — pra "Esperando sua resposta" e os totais aparecerem sem precisar
// de F5 manual.
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), INTERVAL_MS);
    return () => clearInterval(interval);
  }, [router]);

  return null;
}
