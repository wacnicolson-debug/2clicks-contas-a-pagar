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
  const [status, setStatus] = useState<Status>(
    isCliente ? (transaction.paid ? "PAGO" : "A_PAGAR") : (transaction.paymentStatus ?? "A_PAGAR")
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body: Record<string, unknown> = {
      categoryName,
      amount: parseFloat(amount.replace(",", ".")),
      dueDate,
      noteNumber,
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
    router.push("/lancamentos");
    router.refresh();
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
      </form>
    </div>
  );
}
