"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RemoveSheetButton({ id, year }: { id: string; year: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleRemove() {
    if (
      !confirm(
        `Remover o link da planilha ${year} daqui? Isso não apaga nada no Google Drive — use só se você já excluiu a planilha por lá.`
      )
    ) {
      return;
    }
    setLoading(true);
    const res = await fetch(`/api/company-sheets/${id}`, { method: "DELETE" });
    setLoading(false);
    if (res.ok) {
      router.refresh();
    } else {
      alert("Não foi possível remover. Tente de novo.");
    }
  }

  return (
    <button
      onClick={handleRemove}
      disabled={loading}
      className="text-neutral-400 hover:text-red-600 disabled:opacity-50"
      title={`Remover link da planilha ${year}`}
    >
      {loading ? "..." : "✕"}
    </button>
  );
}
