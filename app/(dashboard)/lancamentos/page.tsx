import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { DeleteButton } from "./delete-button";

const STATUS_LABEL: Record<string, string> = {
  PAGO: "Pago",
  A_PAGAR: "A pagar",
};

export default async function LancamentosPage() {
  const session = await getSession();
  if (!session) return null;

  const transactions = await prisma.transaction.findMany({
    where: { companyId: session.companyId },
    include: { supplier: true, category: true },
    orderBy: { dueDate: "desc" },
    take: 200,
  });

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <Link href="/dashboard" className="text-sm text-neutral-500">
            ← Voltar ao painel
          </Link>
          <h1 className="text-lg font-semibold mt-2">Lançamentos</h1>
          <p className="text-sm text-neutral-500">
            Os 200 mais recentes. Excluir aqui também limpa a linha na planilha.
          </p>
        </header>

        {transactions.length === 0 ? (
          <p className="text-sm text-neutral-500 bg-white border border-neutral-200 rounded-lg p-5">
            Nenhum lançamento ainda.
          </p>
        ) : (
          <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-neutral-50 text-left text-neutral-500 text-xs uppercase">
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
                    <td className="px-4 py-2 text-neutral-500">
                      {t.paymentStatus ? STATUS_LABEL[t.paymentStatus] : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <DeleteButton id={t.id} label={t.supplier.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
