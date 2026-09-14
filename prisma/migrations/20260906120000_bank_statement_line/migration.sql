-- Feature "Adicionar Extrato": Document ganha um tipo (notas vs extrato
-- bancário) e BankStatementLine (tabela existente, 0 linhas até agora) fica
-- de verdade ligada ao Document (era um campo solto sem FK) + ganha a coluna
-- que liga uma linha órfã à DocumentPage criada pra ela.

CREATE TYPE "DocumentKind" AS ENUM ('INVOICES', 'BANK_STATEMENT');
ALTER TABLE "Document" ADD COLUMN "kind" "DocumentKind" NOT NULL DEFAULT 'INVOICES';

CREATE TYPE "BankLineStatus" AS ENUM ('MATCHED', 'ORPHAN', 'CLASSIFIED');
ALTER TABLE "BankStatementLine" ALTER COLUMN "status" TYPE "BankLineStatus" USING "status"::"BankLineStatus";

ALTER TABLE "BankStatementLine" ADD COLUMN "documentPageId" TEXT;
CREATE UNIQUE INDEX "BankStatementLine_documentPageId_key" ON "BankStatementLine"("documentPageId");

ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
