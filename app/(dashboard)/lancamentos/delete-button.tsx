"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!confirm(`Excluir o lançamento "${label}"? Isso também limpa a linha na planilha.`)) {
      return;
    }
    setLoading(true);
    const res = await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    setLoading(false);
    if (res.ok) {
      router.refresh();
    } else {
      alert("Não foi possível excluir. Tente de novo.");
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="text-sm text-red-600 hover:underline disabled:opacity-50"
    >
      {loading ? "Excluindo..." : "Excluir"}
    </button>
  );
}
