"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NovaEmpresaPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName, username, password }),
    });

    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Não foi possível criar. Tente de novo.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="min-h-screen bg-neutral-50 px-4 py-10">
        <div className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8 space-y-6">
          <p className="text-sm">
            Empresa "{companyName}" criada, com login "{username}". Saia da conta atual e entre
            com esse usuário e senha pra configurar essa empresa (conectar o Google Sheets dela
            é o primeiro passo).
          </p>
          <Link
            href="/dashboard"
            className="block text-center w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium"
          >
            Voltar ao painel
          </Link>
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
          <h1 className="text-lg font-semibold mb-1">Nova empresa</h1>
          <p className="text-sm text-neutral-500">
            Cada empresa tem seu próprio login, planilha e lançamentos — totalmente
            separada das outras.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="companyName">
            Nome da empresa
          </label>
          <input
            id="companyName"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="username">
            Usuário de login
          </label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="password">
            Senha
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            required
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-emerald-700 text-white rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {loading ? "Criando..." : "Criar empresa"}
          </button>
          <Link
            href="/dashboard"
            className="px-4 border border-neutral-300 rounded-md text-sm text-neutral-600 flex items-center"
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
