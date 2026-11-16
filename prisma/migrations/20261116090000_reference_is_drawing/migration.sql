-- AlterTable
ALTER TABLE "designs" ADD COLUMN     "reference_is_drawing" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote_requests" ADD COLUMN     "reference_is_drawing" BOOLEAN NOT NULL DEFAULT false;


-- Designs already made from a drawing: their own product's description says its picture renders the customer's sketch.
UPDATE "designs" d SET "reference_is_drawing" = true FROM "products" p WHERE d."product_id" = p."id" AND p."owner_id" IS NOT NULL AND p."description" LIKE '%AI rendering of the customer''s sketch%';
UPDATE "quote_requests" q SET "reference_is_drawing" = true FROM "designs" d WHERE q."design_id" = d."id" AND d."reference_is_drawing";
