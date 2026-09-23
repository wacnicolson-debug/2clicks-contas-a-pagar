"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type FileStatus = "pending" | "uploading" | "done" | "error";

type FileEntry = {
  file: File;
  status: FileStatus;
  error?: string;
  duplicateDocumentId?: string;
};

const STATUS_LABEL: Record<FileStatus, string> = {
  pending: "Na fila",
  uploading: "Enviando...",
  done: "Enviado",
  error: "Falha",
};

export default function PaymentListUploadPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function handleFilesSelected(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    setEntries(files.map((file) => ({ file, status: "pending" })));
  }

  // Cola um print (Ctrl+V) direto da área de transferência, sem precisar
  // salvar a imagem num arquivo antes — funciona em qualquer lugar da
  // página, não só com foco num campo.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (submitting || !e.clipboardData) return;
      const imageItems = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();

      const pastedFiles = imageItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map((file, i) => {
          // Print colado vem com nome genérico ("image.png") — dá um nome
          // com timestamp pra distinguir vários prints na lista.
          const ext = file.type.split("/")[1] ?? "png";
          return new File([file], `print-${Date.now()}-${i}.${ext}`, { type: file.type });
        });
      if (pastedFiles.length === 0) return;

      setEntries((prev) => [...prev, ...pastedFiles.map((file) => ({ file, status: "pending" as const }))]);
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [submitting]);

  function updateEntry(index: number, patch: Partial<FileEntry>) {
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (entries.length === 0 || submitting) return;
    setSubmitting(true);

    for (let i = 0; i < entries.length; i++) {
      updateEntry(i, { status: "uploading" });

      const formData = new FormData();
      formData.append("file", entries[i].file);

      try {
        const res = await fetch("/api/payment-list/upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          updateEntry(i, {
            status: "error",
            error: body.error ?? "Falha ao enviar.",
            duplicateDocumentId: body.duplicateDocumentId,
          });
          continue;
        }
        updateEntry(i, { status: "done" });
      } catch {
        updateEntry(i, { status: "error", error: "Falha ao enviar." });
      }
    }

    setSubmitting(false);
  }

  async function handleDeleteDuplicate(index: number) {
    const documentId = entries[index].duplicateDocumentId;
    if (!documentId) return;
    if (
      !confirm(
        "Isso apaga o envio anterior desse arquivo (e qualquer lançamento que já tenha saído dele). Só faz isso se aquele envio foi um engano. Continuar?"
      )
    ) {
      return;
    }
    const res = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
    if (res.ok) {
      updateEntry(index, { status: "pending", error: undefined, duplicateDocumentId: undefined });
    } else {
      alert("Não foi possível excluir o envio anterior. Tente de novo.");
    }
  }

  const allFinished =
    entries.length > 0 && entries.every((entry) => entry.status === "done" || entry.status === "error");

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8">
        <h1 className="text-lg font-semibold mb-1">Adicionar Relação de Pagamentos</h1>
        <p className="text-sm text-neutral-500 mb-6">
          Suba uma lista/relatório com vários boletos pagos e/ou pix feitos, ou
          vá mandando um recibo por vez (também pode colar um print com
          Ctrl+V). Cada pagamento vira um lançamento já pago. Suba isso ANTES
          do extrato — assim o extrato só aponta o que sobrar sem bater com
          essa lista (juros, tarifas, algo sem nota).
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
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={entry.status === "error" ? "text-red-600" : "text-neutral-500"}>
                      {entry.status === "error" && entry.error ? entry.error : STATUS_LABEL[entry.status]}
                    </span>
                    {entry.duplicateDocumentId && (
                      <button
                        type="button"
                        onClick={() => handleDeleteDuplicate(i)}
                        className="text-xs text-emerald-700 underline whitespace-nowrap"
                      >
                        foi engano, excluir e reenviar
                      </button>
                    )}
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
