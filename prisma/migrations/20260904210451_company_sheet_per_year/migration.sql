-- CreateTable: 1 planilha por empresa POR ANO, em vez de 1 planilha única pra sempre.
CREATE TABLE "CompanySheet" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanySheet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanySheet_companyId_year_key" ON "CompanySheet"("companyId", "year");

ALTER TABLE "CompanySheet" ADD CONSTRAINT "CompanySheet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migra o sheetId antigo de cada empresa pra uma linha de CompanySheet do ano de 2026
-- (todo dado existente até agora é desse ano) antes de remover a coluna antiga.
INSERT INTO "CompanySheet" ("id", "companyId", "year", "spreadsheetId")
SELECT gen_random_uuid()::text, "id", 2026, "sheetId"
FROM "Company"
WHERE "sheetId" IS NOT NULL;

ALTER TABLE "Company" DROP COLUMN "sheetId";

-- SheetRowIndex precisa saber de qual ANO é o contador — "Janeiro" de 2026 e de
-- 2027 são planilhas diferentes, com contadores de linha independentes.
ALTER TABLE "SheetRowIndex" ADD COLUMN "year" INTEGER NOT NULL DEFAULT 2026;
ALTER TABLE "SheetRowIndex" ALTER COLUMN "year" DROP DEFAULT;

DROP INDEX "SheetRowIndex_companyId_tabName_key_key";
CREATE UNIQUE INDEX "SheetRowIndex_companyId_year_tabName_key_key" ON "SheetRowIndex"("companyId", "year", "tabName", "key");
