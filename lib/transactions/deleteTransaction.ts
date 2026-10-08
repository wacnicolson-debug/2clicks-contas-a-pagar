import { prisma } from "@/lib/db/prisma";
import { clearTransactionFromSheet, rebuildDayBlock } from "@/lib/sheets/syncTransaction";

/**
 * Exclusão completa de um lançamento: limpa a linha na planilha, apaga do
 * banco e reseta o "perfil aprendido" do fornecedor. É a mesma regra do botão
 * Excluir da tela de Lançamentos e da coluna EXCLUIR da planilha.
 * Idempotente: se o lançamento já foi apagado (ex: dois pedidos ao mesmo
 * tempo), não faz nada. `cleared` diz se a planilha foi atualizada.
 *
 * A exclusão no banco NUNCA depende da planilha: se limpar a planilha falhar
 * (Google fora do ar, bloco do dia que não dá pra regravar), o lançamento sai
 * do banco mesmo assim — o banco é a fonte da verdade, e uma linha velha na
 * planilha se acerta na próxima regravação do dia.
 */
export async function deleteTransactionEverywhere(
  transactionId: string
): Promise<{ deleted: boolean; cleared: boolean }> {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) return { deleted: false, cleared: false };

  let cleared = false;
  try {
    cleared = await clearTransactionFromSheet(transaction.id);
  } catch (err) {
    console.error(`Falha ao limpar a planilha ao excluir o lançamento ${transaction.id}:`, err);
  }
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

  // A limpeza da planilha falhou: agora que o lançamento já saiu do banco,
  // tenta regravar o dia (que não vai mais incluí-lo).
  if (!cleared && transaction.kind === "PAYABLE" && transaction.sheetCellRef) {
    const tab = transaction.sheetCellRef.split("!")[0];
    try {
      await rebuildDayBlock(
        transaction.companyId,
        transaction.dueDate.getUTCFullYear(),
        tab,
        transaction.dueDate.getUTCDate()
      );
      cleared = true;
    } catch (err) {
      console.error(`Não consegui regravar o dia na planilha depois de excluir ${transaction.id}:`, err);
    }
  }

  return { deleted: true, cleared };
}
