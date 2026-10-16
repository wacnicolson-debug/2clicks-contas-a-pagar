-- CreateTable
CREATE TABLE "StockOpening" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "openingDate" TIMESTAMP(3) NOT NULL,
    "itemName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(14,3),
    "unit" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'AVIAMENTO',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockOpening_companyId_year_idx" ON "StockOpening"("companyId", "year");

-- AddForeignKey
ALTER TABLE "StockOpening" ADD CONSTRAINT "StockOpening_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
