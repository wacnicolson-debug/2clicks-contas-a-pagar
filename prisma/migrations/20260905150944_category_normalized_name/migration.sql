-- Passo 1 de 2: adiciona a coluna sem travar nada ainda. O backfill (e a
-- fusão de categorias que colidirem depois de normalizadas) roda por script
-- (precisa da mesma lógica de normalizeText usada no app, mais simples em
-- TypeScript do que replicar em SQL puro).
ALTER TABLE "Category" ADD COLUMN "normalizedName" TEXT;
