"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Kind = "FORNECEDOR" | "CLIENTE";
type Status = "PAGO" | "A_PAGAR";
type Method = "BOLETO" | "PIX" | "DEBITO_CONTA";

export default function ManualTransactionPage() {
  const router = useRouter();
  const [existingCategories, setExistingCategories] = useState<string[]>([]);

  const [supplierName, setSupplierName] = useState("");
  const [kind, setKind] = useState<Kind>("FORNECEDOR");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<Status>("A_PAGAR");
  const [method, setMethod] = useState<Method>("BOLETO");
  const [pixKey, setPixKey] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [noteNumber, setNoteNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/categories")
      .then((res) => res.json())
      .then((data) => setExistingCategories(data.names ?? []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/transactions/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        supplierName,
        amount: parseFloat(amount),
        dueDate,
        paymentStatus: kind === "FORNECEDOR" ? status : undefined,
        paymentMethod: kind === "FORNECEDOR" ? method : undefined,
        pixKey: kind === "FORNECEDOR" && method === "PIX" ? pixKey : undefined,
        categoryName: categoryName || undefined,
        noteNumber: noteNumber || undefined,
      }),
    });

    setLoading(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Não foi possível salvar. Tente de novo.");
      return;
    }

    setDone(true);
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-md mx-auto">
        <Link href="/dashboard" className="text-sm text-neutral-500">
          ← Voltar ao painel
        </Link>

        <form
          onSubmit={handleSubmit}
          className="mt-4 bg-white border border-neutral-200 rounded-lg p-8 space-y-6"
        >
          <div>
            <h1 className="text-lg font-semibold mb-1">Lançamento manual</h1>
            <p className="text-sm text-neutral-500">
              Pra quando não tem documento pra escanear — um lançamento que precisou
              ser refeito à mão, um débito recorrente já conhecido, etc.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="supplierName">
              Nome do fornecedor/cliente
            </label>
            <input
              id="supplierName"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
              required
            />
            <p className="text-xs text-neutral-400 mt-1">
              Se já existir esse nome cadastrado, o perfil aprendido dele é reaproveitado.
            </p>
          </div>

          <fieldset>
            <legend className="text-sm font-medium mb-2">É Fornecedor ou Cliente?</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={kind === "FORNECEDOR"}
                  onChange={() => setKind("FORNECEDOR")}
                />
                Fornecedor (despesa)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={kind === "CLIENTE"}
                  onChange={() => setKind("CLIENTE")}
                />
                Cliente (receita)
              </label>
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="amount">
                Valor
              </label>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="dueDate">
                Data
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
          </div>

          {kind === "FORNECEDOR" && (
            <>
              <fieldset>
                <legend className="text-sm font-medium mb-2">Pago ou a pagar?</legend>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={status === "PAGO"}
                      onChange={() => setStatus("PAGO")}
                    />
                    Pago
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={status === "A_PAGAR"}
                      onChange={() => setStatus("A_PAGAR")}
                    />
                    A pagar
                  </label>
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium mb-2">Forma de pagamento</legend>
                <div className="flex gap-4 text-sm mb-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={method === "BOLETO"}
                      onChange={() => setMethod("BOLETO")}
                    />
                    Boleto
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={method === "PIX"}
                      onChange={() => setMethod("PIX")}
                    />
                    Pix
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={method === "DEBITO_CONTA"}
                      onChange={() => setMethod("DEBITO_CONTA")}
                    />
                    Débito em conta
                  </label>
                </div>
                {method === "PIX" && (
                  <input
                    placeholder="Chave Pix (opcional)"
                    value={pixKey}
                    onChange={(e) => setPixKey(e.target.value)}
                    className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                  />
                )}
              </fieldset>
            </>
          )}

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="category">
              Categoria de custo
            </label>
            <input
              id="category"
              list="category-suggestions"
              placeholder="ex: energia, matéria-prima, frete..."
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            />
            <datalist id="category-suggestions">
              {existingCategories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="noteNumber">
              Número da nota/boleto (opcional)
            </label>
            <input
              id="noteNumber"
              value={noteNumber}
              onChange={(e) => setNoteNumber(e.target.value)}
              className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {done ? (
            <div className="space-y-3">
              <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                Lançamento salvo e sincronizado com a planilha.
              </p>
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium"
              >
                Voltar ao painel
              </button>
            </div>
          ) : (
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium disabled:opacity-50"
            >
              {loading ? "Salvando..." : "Salvar lançamento"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
