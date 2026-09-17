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
      title="Corrige datas pro padrão brasileiro em todas as abas (Recebimentos e meses) e reorganiza Recebimentos por mês"
    >
      {status === "loading"
        ? "Corrigindo..."
        : status === "done"
          ? "Datas corrigidas ✓"
          : status === "error"
            ? "Erro, tente de novo"
            : "Corrigir datas (todas as abas)"}
    </button>
  );
}
