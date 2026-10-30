-- AlterEnum
ALTER TYPE "AiLimitFeature" ADD VALUE 'CUTOUT';

-- CreateTable
CREATE TABLE "decoration_cutouts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_id" UUID,
    "product_name" TEXT NOT NULL,
    "image_index" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "image_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "palette" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decoration_cutouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decoration_cutouts_image_key_key" ON "decoration_cutouts"("image_key");

-- CreateIndex
CREATE INDEX "decoration_cutouts_customer_id_created_at_idx" ON "decoration_cutouts"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "decoration_cutouts" ADD CONSTRAINT "decoration_cutouts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decoration_cutouts" ADD CONSTRAINT "decoration_cutouts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row level security (no policies: only the server role reads this table)
ALTER TABLE "decoration_cutouts" ENABLE ROW LEVEL SECURITY;
