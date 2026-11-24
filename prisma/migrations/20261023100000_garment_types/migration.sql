-- CreateEnum
CREATE TYPE "GarmentType" AS ENUM ('dress', 'shirt', 'panjabi');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "garment_type" "GarmentType" NOT NULL DEFAULT 'dress';

-- CreateIndex
CREATE INDEX "products_status_garment_type_idx" ON "products"("status", "garment_type");

