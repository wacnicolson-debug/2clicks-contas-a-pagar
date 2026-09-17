import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { EditTransactionForm } from "./edit-form";

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) return null;

  const { id } = await params;

  const transaction = await prisma.transaction.findFirst({
    where: { id, companyId: session.companyId },
    include: { supplier: true, category: true },
  });
  if (!transaction) notFound();

  const categories = await prisma.category.findMany({
    where: { companyId: session.companyId },
    orderBy: { name: "asc" },
    select: { name: true },
  });

  return (
    <EditTransactionForm
      transaction={{
        id: transaction.id,
        kind: transaction.kind,
        supplierName: transaction.supplier.name,
        noteNumber: transaction.noteNumber,
        dueDate: transaction.dueDate.toISOString().slice(0, 10),
        amount: Number(transaction.amount),
        categoryName: transaction.category?.name ?? "",
        paymentStatus: transaction.paymentStatus,
        paid: transaction.paid,
      }}
      categoryNames={categories.map((c) => c.name)}
    />
  );
}
