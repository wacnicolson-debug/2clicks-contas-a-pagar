"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type FileStatus = "pending" | "uploading" | "done" | "error";

type FileEntry = {
  file: File;
  status: FileStatus;
  error?: string;
};

const STATUS_LABEL: Record<FileStatus, string> = {
  pending: "Na fila",
  uploading: "Enviando...",
  done: "Enviado",
  error: "Falha",
};

export default function UploadPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function handleFilesSelected(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    setEntries(files.map((file) => ({ file, status: "pending" })));
  }

  function updateEntry(index: number, patch: Partial<FileEntry>) {
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (entries.length === 0 || submitting) return;
    setSubmitting(true);

    // Sobe um arquivo de cada vez — evita sobrecarregar Storage/IA com vários
    // arquivos grandes ao mesmo tempo, e deixa o progresso claro na lista.
    for (let i = 0; i < entries.length; i++) {
      updateEntry(i, { status: "uploading" });

      const formData = new FormData();
      formData.append("file", entries[i].file);

      try {
        const res = await fetch("/api/documents/upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          updateEntry(i, { status: "error", error: body.error ?? "Falha ao enviar." });
          continue;
        }
        updateEntry(i, { status: "done" });
      } catch {
        updateEntry(i, { status: "error", error: "Falha ao enviar." });
      }
    }

    setSubmitting(false);
  }

  const allFinished =
    entries.length > 0 && entries.every((entry) => entry.status === "done" || entry.status === "error");

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8">
        <h1 className="text-lg font-semibold mb-1">Adicionar Documentos</h1>
        <p className="text-sm text-neutral-500 mb-6">
          Suba um ou vários PDFs/imagens com notas, boletos ou contas — cada
          arquivo pode ter várias páginas, uma nota por página.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="file"
            accept="application/pdf,image/*"
            multiple
            disabled={submitting}
            onChange={(e) => handleFilesSelected(e.target.files)}
            className="block w-full text-sm text-neutral-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-emerald-700 file:text-white file:text-sm file:font-medium file:cursor-pointer hover:file:bg-emerald-800 disabled:opacity-50"
          />

          {entries.length > 0 && (
            <ul className="space-y-1">
              {entries.map((entry, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 text-sm border border-neutral-100 rounded-md px-3 py-2"
                >
                  <span className="truncate">{entry.file.name}</span>
                  <span
                    className={
                      entry.status === "error"
                        ? "text-red-600 shrink-0"
                        : "text-neutral-500 shrink-0"
                    }
                  >
                    {entry.status === "error" && entry.error ? entry.error : STATUS_LABEL[entry.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {allFinished ? (
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium"
            >
              Voltar ao painel
            </button>
          ) : (
            <button
              type="submit"
              disabled={submitting || entries.length === 0}
              className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium disabled:opacity-50"
            >
              {submitting
                ? "Enviando..."
                : `Enviar${entries.length > 1 ? ` (${entries.length})` : ""}`}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
