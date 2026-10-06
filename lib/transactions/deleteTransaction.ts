import { prisma } from "@/lib/db/prisma";
import { clearTransactionFromSheet } from "@/lib/sheets/syncTransaction";

/**
 * Exclusão completa de um lançamento: limpa a linha na planilha, apaga do
 * banco e reseta o "perfil aprendido" do fornecedor. É a mesma regra do botão
 * Excluir da tela de Lançamentos e da coluna EXCLUIR da planilha.
 * Idempotente: se o lançamento já foi apagado (ex: dois pedidos ao mesmo
 * tempo), não faz nada. `cleared` diz se a planilha foi atualizada.
 */
export async function deleteTransactionEverywhere(
  transactionId: string
): Promise<{ deleted: boolean; cleared: boolean }> {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) return { deleted: false, cleared: false };

  const cleared = await clearTransactionFromSheet(transaction.id);
  await prisma.transaction.delete({ where: { id: transaction.id } });

  // Um lançamento excluído é sinal de que o "perfil aprendido" desse
  // fornecedor errou em algo — reseta pra ele voltar a perguntar tudo na
  // próxima nota, em vez de repetir o mesmo erro automaticamente.
  await prisma.supplier.update({
    where: { id: transaction.supplierId },
    data: {
      kind: null,
      defaultStatus: null,
      paymentMethod: null,
      pixKey: null,
      defaultCategoryId: null,
    },
  });

  return { deleted: true, cleared };
}
