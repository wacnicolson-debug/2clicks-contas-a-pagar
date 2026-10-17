import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { costWhere, getRange, parseBase, parsePeriod, referenceDate, type DateBase, type Period } from "@/lib/costs/costRange";

export default async function CustosPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) return null;

  const params = await searchParams;
  const period: Period = parsePeriod(params.periodo);
  const base: DateBase = parseBase(params.base);

  // "data" é só uma data de referência dentro do período que se quer ver —
  // deixa navegar pra mês/trimestre/ano passado (ou futuro), não só o atual.
  const { now, refDateParam } = referenceDate(params.data);
  const { start, end, label } = getRange(period, now);

  const grouped = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: costWhere(session.companyId, base, start, end),
    _sum: { amount: true },
  });

  const categoryIds = grouped.map((g) => g.categoryId).filter((id): id is string => !!id);
  const categories = await prisma.category.findMany({ where: { id: { in: categoryIds } } });
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  const rows = grouped
    .map((g) => ({
      id: g.categoryId ?? "sem-categoria",
      name: g.categoryId ? (categoryNameById.get(g.categoryId) ?? "Categoria removida") : "Sem categoria",
      amount: Number(g._sum.amount ?? 0),
    }))
    .sort((a, b) => b.amount - a.amount);

  // Pra navegar pro período anterior/seguinte, basta pegar uma data que caia
  // dentro dele — 1 dia antes do início do período atual sempre cai no
  // anterior, e o próprio "end" (exclusivo) sempre cai no seguinte. Funciona
  // igual pra mês, trimestre ou ano, sem precisar de lógica por período.
  const prevRef = new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextRef = end.toISOString().slice(0, 10);
  // O período "atual" é o que contém HOJE — não a data de referência da URL (essa é só pra navegar):
  // comparar com ela deixava a seta → desligada em qualquer período aberto pela seta ←.
  const today = new Date();
  const isCurrentPeriod = today >= start && today < end;

  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const maxAmount = Math.max(...rows.map((r) => r.amount), 1);

  const periodTabs: { key: Period; label: string }[] = [
    { key: "mes", label: "Mensal" },
    { key: "trimestre", label: "Trimestral" },
    { key: "ano", label: "Anual" },
  ];

  const baseTabs: { key: DateBase; label: string; hint: string }[] = [
    { key: "pagamento", label: "Data de pagamento", hint: "quando o dinheiro sai (vencimento)" },
    { key: "entrada", label: "Data de entrada", hint: "quando a nota foi lançada — quanto comprou no período" },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6">
          <Link href="/dashboard" className="text-sm text-neutral-500">
            ← Voltar ao painel
          </Link>
          <h1 className="text-lg font-semibold mt-2">Distribuição de custos</h1>
        </header>

        <div className="flex gap-2 mb-2">
          {baseTabs.map((tab) => (
            <Link
              key={tab.key}
              href={`/custos?periodo=${period}&base=${tab.key}${refDateParam ? `&data=${refDateParam}` : ""}`}
              title={tab.hint}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border ${
                base === tab.key
                  ? "bg-neutral-800 text-white border-neutral-800"
                  : "bg-white text-neutral-600 border-neutral-300"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>
        <p className="text-xs text-neutral-400 mb-4">
          {baseTabs.find((t) => t.key === base)?.hint}
        </p>

        <div className="flex gap-2 mb-6">
          {periodTabs.map((tab) => (
            <Link
              key={tab.key}
              href={`/custos?periodo=${tab.key}&base=${base}${refDateParam ? `&data=${refDateParam}` : ""}`}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border ${
                period === tab.key
                  ? "bg-emerald-700 text-white border-emerald-700"
                  : "bg-white text-neutral-600 border-neutral-300"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3 mb-4">
          <Link
            href={`/custos?periodo=${period}&base=${base}&data=${prevRef}`}
            className="text-neutral-400 hover:text-neutral-700 text-sm"
            aria-label="Período anterior"
          >
            ←
          </Link>
          <p className="text-sm text-neutral-500">
            {label} — total:{" "}
            <span className="font-medium text-neutral-700">
              {total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
            </span>
          </p>
          {isCurrentPeriod ? (
            <span className="text-neutral-200 text-sm" aria-hidden>
              →
            </span>
          ) : (
            <Link
              href={`/custos?periodo=${period}&base=${base}&data=${nextRef}`}
              className="text-neutral-400 hover:text-neutral-700 text-sm"
              aria-label="Próximo período"
            >
              →
            </Link>
          )}
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500 bg-white border border-neutral-200 rounded-lg p-5">
            Nenhum custo {base === "entrada" ? "lançado" : "com vencimento"} nesse período ainda.
          </p>
        ) : (
          <div className="bg-white border border-neutral-200 rounded-lg p-5 space-y-4">
            {rows.map((row) => {
              const pct = total > 0 ? (row.amount / total) * 100 : 0;
              const barWidth = (row.amount / maxAmount) * 100;
              const detailHref = `/custos/${row.id}?periodo=${period}&base=${base}${refDateParam ? `&data=${refDateParam}` : ""}`;
              return (
                <Link
                  key={row.id}
                  href={detailHref}
                  className="block rounded-md -mx-2 px-2 py-1 hover:bg-neutral-50"
                  title="Ver tudo que compõe esse gasto"
                >
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{row.name}</span>
                    <span className="text-neutral-500 tabular-nums">
                      {row.amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                      {" · "}
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-2 bg-neutral-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-700 rounded-full"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
