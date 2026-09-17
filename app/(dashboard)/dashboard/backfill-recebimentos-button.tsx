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
      title="Reorganiza a aba Recebimentos por mês (com total no final de cada mês) e corrige as datas pro padrão brasileiro"
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
