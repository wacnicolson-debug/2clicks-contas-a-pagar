-- CreateTable
CREATE TABLE "StockSheet" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentPageId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "noteNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "monthDate" TIMESTAMP(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "categoryName" TEXT,
    "stockKind" TEXT,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "installmentCount" INTEGER NOT NULL DEFAULT 1,
    "remark" TEXT,
    "itemsStatus" TEXT NOT NULL DEFAULT 'NONE',
    "items" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockSheet_companyId_year_key" ON "StockSheet"("companyId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseNote_documentPageId_key" ON "PurchaseNote"("documentPageId");

-- CreateIndex
CREATE INDEX "PurchaseNote_companyId_year_monthDate_idx" ON "PurchaseNote"("companyId", "year", "monthDate");

-- CreateIndex
CREATE INDEX "PurchaseNote_companyId_supplierId_noteNumber_idx" ON "PurchaseNote"("companyId", "supplierId", "noteNumber");

-- AddForeignKey
ALTER TABLE "StockSheet" ADD CONSTRAINT "StockSheet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseNote" ADD CONSTRAINT "PurchaseNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseNote" ADD CONSTRAINT "PurchaseNote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

