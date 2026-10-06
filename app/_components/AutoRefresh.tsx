"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 15000;
const SHEET_CHECK_MS = 20000;

// Atualiza a página sozinha (re-busca os dados do servidor, sem recarregar
// tudo) — pra lançamentos/respostas pendentes novos aparecerem sem precisar
// de F5 manual. Além do intervalo, atualiza também ao voltar pra aba/janela
// — o navegador pode atrasar ou até abortar o fetch do intervalo enquanto a
// aba está em segundo plano (ex: trocou de app pra tirar o print), então
// esse é o gatilho que garante que fica em dia bem na hora que você volta a
// olhar a tela.
//
// Também confere a coluna EXCLUIR da planilha: a planilha não consegue avisar
// o app quando uma caixinha é marcada, então o app pergunta de tempos em
// tempos (e ao voltar pra esta aba). Com a aba em segundo plano o navegador
// pode atrasar essa conferência.
export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let checking = false;

    async function checkSheetDeletions() {
      if (checking) return;
      checking = true;
      try {
        const res = await fetch("/api/sheet-deletions", { method: "POST" });
        const data = await res.json().catch(() => null);
        if (data?.deleted > 0) router.refresh();
      } catch {
        // sem rede ou aba suspensa: tenta de novo na próxima rodada
      } finally {
        checking = false;
      }
    }

    const interval = setInterval(() => router.refresh(), INTERVAL_MS);
    const sheetInterval = setInterval(checkSheetDeletions, SHEET_CHECK_MS);
    checkSheetDeletions();

    function refreshIfVisible() {
      if (document.visibilityState === "visible") {
        router.refresh();
        checkSheetDeletions();
      }
    }
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      clearInterval(interval);
      clearInterval(sheetInterval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [router]);

  return null;
}
