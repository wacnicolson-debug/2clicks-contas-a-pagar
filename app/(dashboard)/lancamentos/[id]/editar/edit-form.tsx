"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "PAYABLE" | "RECEIVABLE";
type Status = "PAGO" | "A_PAGAR";

export function EditTransactionForm({
  transaction,
  categoryNames,
}: {
  transaction: {
    id: string;
    kind: Kind;
    supplierName: string;
    noteNumber: string | null;
    description: string | null;
    dueDate: string;
    amount: number;
    categoryName: string;
    paymentStatus: Status | null;
    paid: boolean;
  };
  categoryNames: string[];
}) {
  const router = useRouter();
  const isCliente = transaction.kind === "RECEIVABLE";

  const [categoryName, setCategoryName] = useState(transaction.categoryName);
  const [amount, setAmount] = useState(transaction.amount.toFixed(2));
  const [dueDate, setDueDate] = useState(transaction.dueDate);
  const [noteNumber, setNoteNumber] = useState(transaction.noteNumber ?? "");
  const [observacao, setObservacao] = useState(transaction.description ?? "");
  const [status, setStatus] = useState<Status>(
    isCliente ? (transaction.paid ? "PAGO" : "A_PAGAR") : (transaction.paymentStatus ?? "A_PAGAR")
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body: Record<string, unknown> = {
      categoryName,
      amount: parseFloat(amount.replace(",", ".")),
      dueDate,
      noteNumber,
      description: observacao,
    };
    if (isCliente) {
      body.paid = status === "PAGO";
    } else {
      body.paymentStatus = status;
    }

    const res = await fetch(`/api/transactions/${transaction.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setLoading(false);
    if (!res.ok) {
      setError("Não foi possível salvar. Tente de novo.");
      return;
    }
    const data = await res.json().catch(() => null);
    const sheet = data?.sheet as { action: string; tab: string | null; row: number | null } | undefined;
    const where = sheet?.tab && sheet.row ? ` (aba ${sheet.tab}, linha ${sheet.row})` : "";
    setResult(
      sheet?.action === "updated"
        ? `Salvo. A linha que já existia na planilha foi atualizada${where}.`
        : sheet?.action === "moved"
          ? `Salvo. A linha desse lançamento foi movida na planilha${where}.`
          : "Salvo no sistema, mas não encontrei a linha desse lançamento na planilha — não mexi na planilha e nenhuma linha nova foi criada. Ajuste a linha na mão, se ela existir."
    );
    router.refresh();
  }

  async function handleResync() {
    if (
      !confirm(
        "Reenviar pra planilha? Só grava se esse lançamento NÃO estiver lá — se já estiver, nada é alterado."
      )
    ) {
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/transactions/${transaction.id}/resync`, { method: "POST" });
    setLoading(false);
    if (!res.ok) {
      setError("Não foi possível reenviar. Tente de novo.");
      return;
    }
    const data = await res.json().catch(() => null);
    const r = data?.result as
      | { action: "exists"; tab: string; row: number }
      | { action: "in_log"; row: number }
      | { action: "created" }
      | undefined;
    setResult(
      r?.action === "exists"
        ? `Esse lançamento já está na planilha (aba ${r.tab}, linha ${r.row}). Nada foi gravado.`
        : r?.action === "in_log"
          ? `Esse lançamento está no histórico oculto "Custos Pagos" (linha ${r.row}), mas pelo status atual ele deveria estar na aba do dia. Nada foi gravado — use Editar e salve pra mover essa mesma linha.`
          : "Esse lançamento não estava na planilha, então foi gravado agora."
    );
    router.refresh();
  }

  if (result) {
    return (
      <div className="min-h-screen bg-neutral-50 px-4 py-10">
        <div className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8 space-y-6">
          <p className="text-sm">{result}</p>
          <button
            type="button"
            onClick={() => router.push("/lancamentos")}
            className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium"
          >
            Voltar aos lançamentos
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <form
        onSubmit={handleSubmit}
        className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8 space-y-6"
      >
        <div>
          <h1 className="text-lg font-semibold mb-1">Editar lançamento — {transaction.supplierName}</h1>
          <p className="text-sm text-neutral-500">
            Corrige o que estiver errado e salva — atualiza a planilha automaticamente.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="category">
            Categoria de custo
          </label>
          <input
            id="category"
            list="category-suggestions"
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          />
          <datalist id="category-suggestions">
            {categoryNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="amount">
            Valor
          </label>
          <input
            id="amount"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="dueDate">
            Vencimento
          </label>
          <input
            id="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="noteNumber">
            Nº da nota
          </label>
          <input
            id="noteNumber"
            value={noteNumber}
            onChange={(e) => setNoteNumber(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="observacao">
            Observação
          </label>
          <input
            id="observacao"
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="vai direto pra coluna Observações da planilha"
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium mb-2">
            {isCliente ? "Recebido ou a receber?" : "Pago ou a pagar?"}
          </legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={status === "PAGO"} onChange={() => setStatus("PAGO")} />
              {isCliente ? "Recebido" : "Pago"}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={status === "A_PAGAR"} onChange={() => setStatus("A_PAGAR")} />
              {isCliente ? "A receber" : "A pagar"}
            </label>
          </div>
        </fieldset>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-emerald-700 text-white rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {loading ? "Salvando..." : "Salvar"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/lancamentos")}
            className="px-4 border border-neutral-300 rounded-md text-sm text-neutral-600"
          >
            Cancelar
          </button>
        </div>

        <button
          type="button"
          onClick={handleResync}
          disabled={loading}
          className="w-full text-xs text-neutral-500 underline disabled:opacity-50"
        >
          Reenviar pra planilha (só grava se a linha não existir)
        </button>
      </form>
    </div>
  );
}
