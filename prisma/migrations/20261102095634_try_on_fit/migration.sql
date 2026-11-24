-- CreateEnum
CREATE TYPE "FitPreference" AS ENUM ('fitted', 'regular', 'relaxed');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "length_cm" INTEGER;

-- AlterTable
ALTER TABLE "try_on_results" ADD COLUMN     "fit" JSONB;

-- CreateTable
CREATE TABLE "body_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "height_cm" INTEGER NOT NULL,
    "weight_kg" INTEGER NOT NULL,
    "fit_preference" "FitPreference" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "body_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "body_profiles_user_id_key" ON "body_profiles"("user_id");

-- AddForeignKey
ALTER TABLE "body_profiles" ADD CONSTRAINT "body_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Sane values only (the app validates the same ranges, lib/fit/fit.ts).
ALTER TABLE "body_profiles" ADD CONSTRAINT "body_profiles_height_cm_check" CHECK ("height_cm" BETWEEN 120 AND 220);
ALTER TABLE "body_profiles" ADD CONSTRAINT "body_profiles_weight_kg_check" CHECK ("weight_kg" BETWEEN 30 AND 200);
ALTER TABLE "products" ADD CONSTRAINT "products_length_cm_check" CHECK ("length_cm" IS NULL OR "length_cm" BETWEEN 30 AND 200);

-- Row-level security on every new table (no policies: only the server's own connection reads it).
ALTER TABLE "body_profiles" ENABLE ROW LEVEL SECURITY;
