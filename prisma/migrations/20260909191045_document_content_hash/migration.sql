-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "contentHash" TEXT;

-- CreateIndex
CREATE INDEX "Document_companyId_contentHash_idx" ON "Document"("companyId", "contentHash");
