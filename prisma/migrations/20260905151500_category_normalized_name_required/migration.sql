-- Passo 2 de 2: já com normalizedName preenchido pra todo mundo (script
-- backfill_category_normalized.ts rodado antes desta migração), agora trava
-- a coluna como obrigatória e a unicidade passa a ser por ela, não por "name".
ALTER TABLE "Category" ALTER COLUMN "normalizedName" SET NOT NULL;

DROP INDEX "Category_companyId_name_key";
CREATE UNIQUE INDEX "Category_companyId_normalizedName_key" ON "Category"("companyId", "normalizedName");
