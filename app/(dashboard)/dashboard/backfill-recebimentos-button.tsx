"use client";

import { useState } from "react";

export function BackfillRecebimentosButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleClick() {
    setStatus("loading");
    const res = await fetch("/api/admin/backfill-recebimentos", { method: "POST" });
    setStatus(res.ok ? "done" : "error");
  }

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
      title="Corrige datas para o padrão brasileiro e adiciona o resumo mensal na aba Recebimentos"
    >
      {status === "loading"
        ? "Corrigindo..."
        : status === "done"
          ? "Recebimentos corrigido ✓"
          : status === "error"
            ? "Erro, tente de novo"
            : "Corrigir aba Recebimentos"}
    </button>
  );
}
