-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ORDER_CONFIRMED', 'DESIGN_ACCEPTED', 'ITEM_REFUNDED', 'SHIPPED', 'DELIVERED', 'QUOTE_READY', 'QUOTE_DECLINED', 'QUOTE_EXPIRED', 'DISPUTE_REFUNDED', 'DISPUTE_CLOSED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "unique_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_unique_key_key" ON "notifications"("unique_key");

-- CreateIndex
CREATE INDEX "notifications_status_run_after_idx" ON "notifications"("status", "run_after");

-- CreateIndex
CREATE INDEX "notifications_customer_id_created_at_idx" ON "notifications"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security (no policies: only the server, via Prisma, may read or write).
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
