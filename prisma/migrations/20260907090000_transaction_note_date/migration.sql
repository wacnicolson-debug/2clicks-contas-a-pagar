-- Nota de prazo longo lançada com atraso: o custo precisa contar no mês da
-- nota (emissão real), não no mês do vencimento (que pode ser bem depois).
ALTER TABLE "Transaction" ADD COLUMN "noteDate" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "costLogCellRef" TEXT;
