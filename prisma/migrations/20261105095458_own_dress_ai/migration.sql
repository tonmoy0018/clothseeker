-- Customers' own dresses get the AI design box too (decided 2026-11-05).
UPDATE "customization_templates" SET "ai_enabled" = true
WHERE "product_id" IN (SELECT "id" FROM "products" WHERE "status" = 'PRIVATE');
