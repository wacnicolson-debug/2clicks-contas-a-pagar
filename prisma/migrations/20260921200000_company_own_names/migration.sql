-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "ownNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
