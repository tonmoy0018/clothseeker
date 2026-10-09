-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_role" TEXT;


-- Existing rows: take the role from the account where it still exists; rows without an actor were system sweeps.
UPDATE "audit_logs" a SET "actor_role" = u."role"::text FROM "users" u WHERE a."actor_id" = u."id";
UPDATE "audit_logs" SET "actor_role" = 'SYSTEM' WHERE "actor_id" IS NULL AND "action" = 'tryon.cleanup';
