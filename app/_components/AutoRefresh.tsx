"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 15000;

// Atualiza a página sozinha (re-busca os dados do servidor, sem recarregar
// tudo) — pra lançamentos/respostas pendentes novos aparecerem sem precisar
// de F5 manual. Além do intervalo, atualiza também ao voltar pra aba/janela
// — o navegador pode atrasar ou até abortar o fetch do intervalo enquanto a
// aba está em segundo plano (ex: trocou de app pra tirar o print), então
// esse é o gatilho que garante que fica em dia bem na hora que você volta a
// olhar a tela.
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), INTERVAL_MS);

    function refreshIfVisible() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [router]);

  return null;
}
