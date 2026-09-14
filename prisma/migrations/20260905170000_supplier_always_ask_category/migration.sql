-- Exceção pra fornecedores cujas notas são visualmente idênticas mas mudam
-- de categoria (ex: mão de obra normal vs hora extra) — pra esses, sempre
-- pergunta a categoria de novo, mesmo já conhecendo o resto do perfil.
ALTER TABLE "Supplier" ADD COLUMN "alwaysAskCategory" BOOLEAN NOT NULL DEFAULT false;
