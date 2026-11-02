-- AlterEnum
ALTER TYPE "ProductStatus" ADD VALUE 'PRIVATE';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "owner_id" UUID;

-- CreateIndex
CREATE INDEX "products_owner_id_idx" ON "products"("owner_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

