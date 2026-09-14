"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

type PageStatus = "PENDING" | "PROCESSING" | "AWAITING_USER_INPUT" | "DONE" | "ERROR";

type DocumentStatusResponse = {
  id: string;
  status: PageStatus;
  originalFilename: string;
  pages: {
    id: string;
    pageNumber: number;
    status: PageStatus;
    supplierName: string | null;
    duplicateOfPageNumber: number | null;
  }[];
  matchedLines: { id: string; description: string; amount: number; date: string }[];
};

const STATUS_LABEL: Record<PageStatus, string> = {
  PENDING: "Na fila",
  PROCESSING: "Lendo com IA...",
  AWAITING_USER_INPUT: "Aguardando suas respostas",
  DONE: "Lançado",
  ERROR: "Erro",
};

export default function DocumentStatusPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<DocumentStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const res = await fetch(`/api/documents/${params.id}`);
      if (cancelled || !res.ok) return;
      const json = (await res.json()) as DocumentStatusResponse;
      setData(json);
      if (json.status === "PENDING" || json.status === "PROCESSING") {
        setTimeout(poll, 1500);
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  // Terminou tudo (todas as páginas lançadas) — volta sozinho pro painel
  // depois de um instante, só pra dar tempo de ver o "Lançado" na tela.
  useEffect(() => {
    if (data?.status !== "DONE") return;
    const timeout = setTimeout(() => router.push("/dashboard"), 1500);
    return () => clearTimeout(timeout);
  }, [data?.status, router]);

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8">
        <h1 className="text-lg font-semibold mb-1">{data?.originalFilename ?? "Processando..."}</h1>
        <p className="text-sm text-neutral-500 mb-6">
          {data ? STATUS_LABEL[data.status] : "Carregando..."}
        </p>

        <ul className="space-y-2">
          {data?.pages.map((page) => (
            <li
              key={page.id}
              className="flex items-center justify-between text-sm border border-neutral-100 rounded-md px-3 py-2"
            >
              <span>
                Página {page.pageNumber} — {page.supplierName ?? "identificando..."}
              </span>
              {page.status === "AWAITING_USER_INPUT" ? (
                <Link
                  href={`/documentos/${data.id}/perguntas/${page.id}`}
                  className="text-emerald-700 font-medium"
                >
                  Responder
                </Link>
              ) : page.duplicateOfPageNumber ? (
                <span className="text-neutral-400">
                  Já contabilizada (pág. {page.duplicateOfPageNumber})
                </span>
              ) : (
                <span className="text-neutral-500">{STATUS_LABEL[page.status]}</span>
              )}
            </li>
          ))}
        </ul>

        {data && data.matchedLines.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-neutral-500 mb-2">
              Linhas conferidas (já batiam com um lançamento)
            </p>
            <ul className="space-y-2">
              {data.matchedLines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center justify-between text-sm border border-neutral-100 rounded-md px-3 py-2"
                >
                  <span className="truncate">
                    {new Date(line.date + "T00:00:00").toLocaleDateString("pt-BR")} —{" "}
                    {line.description}
                  </span>
                  <span className="text-emerald-700 shrink-0 ml-3">
                    ✓{" "}
                    {line.amount.toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Link href="/dashboard" className="block text-sm text-neutral-500 mt-6">
          ← Voltar ao painel
        </Link>
      </div>
    </div>
  );
}
