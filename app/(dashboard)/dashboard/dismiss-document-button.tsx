"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DismissDocumentButton({ documentId, label }: { documentId: string; label: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDismiss() {
    if (!confirm(`Descartar "${label}" daqui? Isso libera o arquivo pra ser enviado de novo.`)) {
      return;
    }
    setLoading(true);
    const res = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
    setLoading(false);
    if (res.ok) {
      router.refresh();
    } else {
      alert("Não foi possível descartar. Tente de novo.");
    }
  }

  return (
    <button
      onClick={handleDismiss}
      disabled={loading}
      className="text-sm text-red-600 hover:underline disabled:opacity-50"
    >
      {loading ? "Descartando..." : "Descartar"}
    </button>
  );
}
