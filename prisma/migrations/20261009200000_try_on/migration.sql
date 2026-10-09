-- AlterTable
ALTER TABLE "try_on_photos" ADD COLUMN     "checked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "try_on_results" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "design_id" UUID,
    "product_id" UUID,
    "garment_hash" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "result_key" TEXT NOT NULL,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "job_id" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "try_on_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "try_on_results_job_id_key" ON "try_on_results"("job_id");

-- CreateIndex
CREATE INDEX "try_on_results_saved_created_at_idx" ON "try_on_results"("saved", "created_at");

-- CreateIndex
CREATE INDEX "try_on_results_customer_id_created_at_idx" ON "try_on_results"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "try_on_results_customer_id_input_hash_idx" ON "try_on_results"("customer_id", "input_hash");

-- AddForeignKey
ALTER TABLE "try_on_results" ADD CONSTRAINT "try_on_results_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "try_on_results" ADD CONSTRAINT "try_on_results_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "try_on_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "try_on_results" ADD CONSTRAINT "try_on_results_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "designs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "try_on_results" ADD CONSTRAINT "try_on_results_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "try_on_results" ADD CONSTRAINT "try_on_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security (no policies: only the server, via Prisma, may read or write).
ALTER TABLE "try_on_results" ENABLE ROW LEVEL SECURITY;
