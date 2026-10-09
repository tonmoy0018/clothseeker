-- CreateEnum
CREATE TYPE "AiLimitFeature" AS ENUM ('DESIGN_ROUND', 'TRY_ON', 'SUBMISSIONS');

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "photo_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "resolved_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "flagged_items" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ai_limit_hits" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "feature" "AiLimitFeature" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_limit_hits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "worker_id" TEXT NOT NULL,
    "planner" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "try_on" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

-- CreateIndex
CREATE INDEX "ai_limit_hits_created_at_idx" ON "ai_limit_hits"("created_at");

-- CreateIndex
CREATE INDEX "worker_heartbeats_last_seen_at_idx" ON "worker_heartbeats"("last_seen_at");

-- CreateIndex
CREATE INDEX "disputes_order_item_id_idx" ON "disputes"("order_item_id");

-- AddForeignKey
ALTER TABLE "ai_limit_hits" ADD CONSTRAINT "ai_limit_hits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security (no policies: only the server, via Prisma, may read or write).
ALTER TABLE "ai_limit_hits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_heartbeats" ENABLE ROW LEVEL SECURITY;
