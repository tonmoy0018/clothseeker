-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "error_code" TEXT;

-- AlterTable
ALTER TABLE "ai_rounds" ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "job_id" UUID NOT NULL,
ADD COLUMN     "options" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE UNIQUE INDEX "ai_rounds_job_id_key" ON "ai_rounds"("job_id");

-- CreateIndex
CREATE INDEX "ai_rounds_customer_id_input_hash_idx" ON "ai_rounds"("customer_id", "input_hash");

-- AddForeignKey
ALTER TABLE "ai_rounds" ADD CONSTRAINT "ai_rounds_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

