-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "quote_requests" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "preview_key" TEXT,
ADD COLUMN     "reference_photo_key" TEXT,
ADD COLUMN     "spec_snapshot" JSONB NOT NULL;

-- CreateIndex
CREATE INDEX "quote_requests_status_expires_at_idx" ON "quote_requests"("status", "expires_at");

