import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { costWhere, getRange, parseBase, parsePeriod, referenceDate } from "@/lib/costs/costRange";

const BRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const BR_DATE = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join("/");

const PAYMENT_LABEL: Record<string, string> = { BOLETO: "Boleto", PIX: "Pix", DEBITO_CONTA: "Débito em conta" };

const MAX_ROWS = 2000;

export default async function CustoDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ categoria: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) return null;

  const { categoria } = await params;
  const query = await searchParams;
  const period = parsePeriod(query.periodo);
  const base = parseBase(query.base);
  const { now, refDateParam } = referenceDate(query.data);
  const { start, end, label } = getRange(period, now);

  const semCategoria = categoria === "sem-categoria";
  const category = semCategoria
    ? null
    : await prisma.category.findFirst({ where: { id: categoria, companyId: session.companyId } });
  const categoryName = semCategoria ? "Sem categoria" : (category?.name ?? "Categoria removida");

  const transactions = await prisma.transaction.findMany({
    where: {
      AND: [costWhere(session.companyId, base, start, end)],
      categoryId: semCategoria ? null : categoria,
    },
    include: { supplier: { select: { name: true } } },
    orderBy: [{ dueDate: "asc" }, { amount: "desc" }],
    take: MAX_ROWS,
  });

  const total = transactions.reduce((sum, t) => sum + Number(t.amount), 0);

  // Subtotal por fornecedor: responde "de quem foi esse gasto" sem precisar somar a lista.
  const bySupplier = new Map<string, { amount: number; count: number }>();
  for (const t of transactions) {
    const cur = bySupplier.get(t.supplier.name) ?? { amount: 0, count: 0 };
    bySupplier.set(t.supplier.name, { amount: cur.amount + Number(t.amount), count: cur.count + 1 });
  }
  const suppliers = [...bySupplier.entries()].sort((a, b) => b[1].amount - a[1].amount);

  const backHref = `/custos?periodo=${period}&base=${base}${refDateParam ? `&data=${refDateParam}` : ""}`;
  const dateHeader = base === "entrada" ? "Data da nota" : "Vencimento";

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <Link href={backHref} className="text-sm text-neutral-500">
            ← Voltar à distribuição de custos
          </Link>
          <h1 className="text-lg font-semibold mt-2">{categoryName}</h1>
          <p className="text-sm text-neutral-500">
            {label} · {base === "entrada" ? "data de entrada" : "data de pagamento"} ·{" "}
            <span className="font-medium text-neutral-700">{BRL(total)}</span> em {transactions.length}{" "}
            {transactions.length === 1 ? "lançamento" : "lançamentos"}
          </p>
        </header>

        {transactions.length === 0 ? (
          <p className="text-sm text-neutral-500 bg-white border border-neutral-200 rounded-lg p-5">
            Nenhum lançamento dessa categoria nesse período.
          </p>
        ) : (
          <>
            <section className="bg-white border border-neutral-200 rounded-lg p-5 mb-6">
              <h2 className="text-sm font-semibold mb-3">Por fornecedor</h2>
              <ul className="space-y-1 text-sm">
                {suppliers.map(([name, v]) => (
                  <li key={name} className="flex justify-between gap-4">
                    <span>
                      {name}
                      <span className="text-neutral-400"> ({v.count})</span>
                    </span>
                    <span className="tabular-nums text-neutral-600">
                      {BRL(v.amount)} · {total > 0 ? ((v.amount / total) * 100).toFixed(0) : 0}%
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="bg-white border border-neutral-200 rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-neutral-50 text-left text-neutral-500 text-xs uppercase">
                    <th className="px-4 py-2 font-medium">{dateHeader}</th>
                    <th className="px-4 py-2 font-medium">Fornecedor</th>
                    <th className="px-4 py-2 font-medium">Nº da nota</th>
                    <th className="px-4 py-2 font-medium">Forma</th>
                    <th className="px-4 py-2 font-medium">Observação</th>
                    <th className="px-4 py-2 font-medium text-right">Valor</th>
                    <th className="px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id} className="border-t border-neutral-100">
                      <td className="px-4 py-2 tabular-nums whitespace-nowrap">
                        {BR_DATE(base === "entrada" ? (t.noteDate ?? t.dueDate) : t.dueDate)}
                        {base === "entrada" && t.noteDate && (
                          <span className="block text-xs text-neutral-400">venc. {BR_DATE(t.dueDate)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">{t.supplier.name}</td>
                      <td className="px-4 py-2 text-neutral-500">{t.noteNumber ?? "—"}</td>
                      <td className="px-4 py-2 text-neutral-500 whitespace-nowrap">
                        {t.paymentMethod ? (PAYMENT_LABEL[t.paymentMethod] ?? t.paymentMethod) : "—"}
                      </td>
                      <td className="px-4 py-2 text-neutral-500">{t.description ?? ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{BRL(Number(t.amount))}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <Link href={`/lancamentos/${t.id}/editar`} className="text-emerald-700 hover:underline">
                          Editar
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-neutral-200 bg-neutral-50 font-medium">
                    <td className="px-4 py-2" colSpan={5}>
                      Total
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{BRL(total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </section>
            {transactions.length >= MAX_ROWS && (
              <p className="text-xs text-neutral-500 mt-2">
                Mostrando os primeiros {MAX_ROWS} lançamentos. O total acima conta só estes.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
