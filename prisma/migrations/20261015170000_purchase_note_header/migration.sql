-- AlterTable
ALTER TABLE "PurchaseNote" ADD COLUMN     "header" JSONB,
ADD COLUMN     "headerStatus" TEXT NOT NULL DEFAULT 'PENDING';
