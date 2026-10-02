import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { DeleteButton } from "./delete-button";
import { AutoRefresh } from "@/app/_components/AutoRefresh";
import type { Prisma } from "@prisma/client";

const STATUS_LABEL: Record<string, string> = {
  PAGO: "Pago",
  A_PAGAR: "A pagar",
};

const PAGE_SIZE = 500;

const SORT_OPTIONS = {
  venc_asc: "Vencimento (mais próximo)",
  venc_desc: "Vencimento (mais distante)",
  valor_desc: "Valor (maior)",
  valor_asc: "Valor (menor)",
} as const;
type SortKey = keyof typeof SORT_OPTIONS;

const SORT_ORDER: Record<SortKey, Prisma.TransactionOrderByWithRelationInput[]> = {
  venc_asc: [{ dueDate: "asc" }, { createdAt: "asc" }],
  venc_desc: [{ dueDate: "desc" }, { createdAt: "desc" }],
  valor_desc: [{ amount: "desc" }, { dueDate: "asc" }],
  valor_asc: [{ amount: "asc" }, { dueDate: "asc" }],
};

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export default async function LancamentosPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) return null;

  const params = await searchParams;
  const q = firstParam(params.q);
  const month = /^\d{4}-\d{2}$/.test(firstParam(params.month)) ? firstParam(params.month) : "";
  const sortParam = firstParam(params.sort);
  const sort: SortKey | "" = Object.hasOwn(SORT_OPTIONS, sortParam) ? (sortParam as SortKey) : "";
  const page = Math.max(1, parseInt(firstParam(params.p), 10) || 1);

  const where: Prisma.TransactionWhereInput = { companyId: session.companyId };
  if (q) {
    where.OR = [
      { supplier: { name: { contains: q, mode: "insensitive" } } },
      { noteNumber: { contains: q, mode: "insensitive" } },
    ];
  }
  if (month) {
    const [year, m] = month.split("-").map(Number);
    where.dueDate = { gte: new Date(Date.UTC(year, m - 1, 1)), lt: new Date(Date.UTC(year, m, 1)) };
  }

  const [total, transactions] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      include: { supplier: true, category: true },
      // Ordem escolhida tem prioridade. Sem escolha e sem mês: os mais
      // recém-lançados primeiro. Com mês: na ordem do calendário, que é como se
      // confere um mês.
      orderBy: sort
        ? SORT_ORDER[sort]
        : month
          ? [{ dueDate: "asc" }, { createdAt: "asc" }]
          : { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (month) search.set("month", month);
    if (sort) search.set("sort", sort);
    if (p > 1) search.set("p", String(p));
    const qs = search.toString();
    return `/lancamentos${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <AutoRefresh />
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <Link href="/dashboard" className="text-sm text-neutral-500">
            ← Voltar ao painel
          </Link>
          <h1 className="text-lg font-semibold mt-2">Lançamentos</h1>
          <p className="text-sm text-neutral-500">
            Excluir aqui também limpa a linha na planilha.
          </p>
        </header>

        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="q">
              Fornecedor ou nº da nota
            </label>
            <input
              id="q"
              name="q"
              defaultValue={q}
              placeholder="ex: tear, 180017"
              className="border border-neutral-300 rounded-md px-3 py-2 text-sm bg-white"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="month">
              Mês do vencimento
            </label>
            <input
              id="month"
              name="month"
              type="month"
              defaultValue={month}
              className="border border-neutral-300 rounded-md px-3 py-2 text-sm bg-white"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1" htmlFor="sort">
              Ordenar por
            </label>
            <select
              id="sort"
              name="sort"
              defaultValue={sort}
              className="border border-neutral-300 rounded-md px-3 py-2 text-sm bg-white"
            >
              <option value="">{month ? "Vencimento (padrão do mês)" : "Mais recentes lançados"}</option>
              {Object.entries(SORT_OPTIONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="bg-emerald-700 text-white rounded-md px-4 py-2 text-sm font-medium">
            Filtrar
          </button>
          {(q || month || sort) && (
            <Link href="/lancamentos" className="text-sm text-neutral-500 underline py-2">
              Limpar
            </Link>
          )}
        </form>

        <p className="text-xs text-neutral-500 mb-2">
          {total === 0
            ? "Nenhum lançamento encontrado."
            : `Mostrando ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + transactions.length} de ${total}`}
        </p>

        {transactions.length === 0 ? (
          <p className="text-sm text-neutral-500 bg-white border border-neutral-200 rounded-lg p-5">
            {q || month ? "Nenhum lançamento com esse filtro." : "Nenhum lançamento ainda."}
          </p>
        ) : (
          <div className="bg-white border border-neutral-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-neutral-50 text-left text-neutral-500 text-xs uppercase">
                  <th className="px-4 py-2 font-medium"></th>
                  <th className="px-4 py-2 font-medium">Fornecedor/Cliente</th>
                  <th className="px-4 py-2 font-medium">Nº da nota</th>
                  <th className="px-4 py-2 font-medium">Vencimento</th>
                  <th className="px-4 py-2 font-medium">Valor</th>
                  <th className="px-4 py-2 font-medium">Categoria</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id} className="border-t border-neutral-100">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Link href={`/lancamentos/${t.id}/editar`} className="text-sm text-emerald-700 hover:underline">
                        Editar
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      {t.supplier.name}
                      <span className="text-neutral-400">
                        {" "}
                        ({t.kind === "RECEIVABLE" ? "cliente" : "fornecedor"})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{t.noteNumber ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {t.dueDate.toISOString().slice(0, 10).split("-").reverse().join("/")}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {Number(t.amount).toLocaleString("pt-BR", {
                        style: "currency",
                        currency: "BRL",
                      })}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{t.category?.name ?? "—"}</td>
                    <td className="px-4 py-2 text-neutral-500 whitespace-nowrap">
                      {t.paymentStatus ? STATUS_LABEL[t.paymentStatus] : "—"}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <DeleteButton id={t.id} label={t.supplier.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lastPage > 1 && (
          <nav className="mt-4 flex items-center justify-between text-sm">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="text-emerald-700 underline">
                ← Anteriores
              </Link>
            ) : (
              <span />
            )}
            <span className="text-neutral-500">
              Página {page} de {lastPage}
            </span>
            {page < lastPage ? (
              <Link href={pageHref(page + 1)} className="text-emerald-700 underline">
                Próximos →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
