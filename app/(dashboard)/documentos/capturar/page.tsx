"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "uploading" | "error";

export default function CapturarPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(file: File | undefined) {
    if (!file) return;
    setStatus("uploading");
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setError(body.error ?? "Falha ao enviar a foto.");
        return;
      }
      router.push(`/documentos/${body.documentId}`);
    } catch {
      setStatus("error");
      setError("Falha ao enviar a foto.");
    }
  }

  function handleRetry() {
    setStatus("idle");
    setError(null);
    inputRef.current?.click();
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-lg font-semibold mb-1">Tirar foto da nota</h1>
        <p className="text-sm text-neutral-500 mb-8">
          A foto sobe e é lançada sozinha, na data de vencimento.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={status === "uploading"}
          onChange={(e) => handleFileSelected(e.target.files?.[0])}
        />

        {status === "error" ? (
          <>
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium"
            >
              Tentar de novo
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={status === "uploading"}
            onClick={() => inputRef.current?.click()}
            className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium disabled:opacity-50"
          >
            {status === "uploading" ? "Enviando..." : "Abrir câmera"}
          </button>
        )}
      </div>
    </div>
  );
}
