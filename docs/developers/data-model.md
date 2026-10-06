# Data model

Source of truth: [`prisma/schema.prisma`](../../prisma/schema.prisma). Migrations are in [`prisma/migrations/`](../../prisma/migrations/). This page explains the model; the schema file has the exact fields.

ClothSeeker is a **single brand**. There are no sellers, stores, store members or payouts.

## Conventions

- **IDs** are UUIDs. `User.id` equals the Supabase `auth.users.id`; there is no cross-schema foreign key.
- **Table and column names** are `snake_case` in Postgres (`@@map` / `@map`) and `camelCase` in TypeScript.
- **Money** is an `Int` in minor units (poisha; 1 BDT = 100 poisha). Columns end in `Minor` (`priceMinor`, `totalMinor`). The currency is BDT ([`lib/money.ts`](../../lib/money.ts)).
- **Timestamps:** `createdAt` everywhere; `updatedAt` on mutable tables.
- **Row Level Security** is enabled on every table with **no policies**. See [Security](#security-row-level-security).

## Entities

| Area | Model | Purpose | Key constraints and indexes |
|---|---|---|---|
| Users | `User` | Profile and role (`CUSTOMER` or `ADMIN`) | `email` unique |
| Catalog | `Category` | Casual, Party, … | `slug` unique |
| | `Product` | A dress. `status` is `DRAFT`, `ACTIVE` or `ARCHIVED`; only `ACTIVE` products are visible in the shop | `slug` unique; index (`status`, `categoryId`) |
| | `Variant` | One size and color of a product, with its price and stock | `sku` unique; unique (`productId`, `size`, `colorName`); index (`productId`, `isActive`) |
| | `CustomizationTemplate` | Customization rules for one product. `config` is validated by [`types/template.ts`](../../types/template.ts) | `productId` unique (1:1) |
| Design | `Design` | A customer's design. `spec` is a versioned DesignSpec (Phase 3) | index (`customerId`, `updatedAt`) |
| | `AIRound` | One AI design round: instruction, attachments, 4 options, chosen index | index (`customerId`, `createdAt`) for the daily quota |
| | `AIJob` (`ai_jobs`) | The worker queue (Phase 6+) | index (`status`, `runAfter`) for claiming; `inputHash` for caching |
| | `TryOnPhoto` | Consented try-on upload. Unsaved photos are deleted after 24 h (Phase 7) | index (`saved`, `createdAt`) for cleanup |
| | `QuoteRequest` | Special-tailoring quote, answered by the team within 24 h (Phase 7) | index (`status`, `respondBy`) |
| Commerce | `Cart`, `CartItem` | One cart per customer. A line is `READY_MADE`, `CUSTOM_DESIGN` or `QUOTE` | `Cart.customerId` unique; unique (`cartId`, `variantId`) |
| | `Order` | One checkout. `status` is `PENDING_PAYMENT`, `PAID`, `CANCELLED` or `REFUNDED` | `number` unique; **`idempotencyKey` unique**; `paymentRef` unique |
| | `OrderItem` | One order line with **snapshots** (name, size, color, unit price, design spec) and its fulfilment `status` | index (`status`, `createdAt`) |
| | `Shipment`, `Review`, `Dispute` | Minimal now, extended in Phases 4, 5 and 8 | one shipment and one review per order item |
| Oversight | `FlaggedItem` | Brand-logo detections for admin review | index (`status`, `createdAt`) |
| | `AuditLog` | Append-only record of sensitive actions; no secrets or personal data in `metadata` | index (`createdAt`), (`targetType`, `targetId`) |

## Order item lifecycle

```
Ready-made:  PENDING_PAYMENT → PAID → READY_TO_SHIP → SHIPPED → DELIVERED
Custom:      PENDING_PAYMENT → PAID → AWAITING_ACCEPTANCE → ACCEPTED → IN_PRODUCTION
             → QC_SUBMITTED → READY_TO_SHIP → SHIPPED → DELIVERED
Any time:    CANCELLED, REFUNDED, DISPUTED (rules in Phase 4)
```

Quote states (`REQUESTED`, `QUOTED`, `DECLINED`, `ACCEPTED`, `EXPIRED`) live on `QuoteRequest`, because an `OrderItem` only exists after checkout. Phase 1 only uses `PENDING_PAYMENT`, `PAID` and `CANCELLED`. Phase 4 adds the single transition module that enforces legal moves.

## Why snapshots

An `OrderItem` copies the product name, size, color and unit price at payment time. A later catalog edit (price change, rename, archive) never changes a past order or its total.

## Security: Row Level Security

Supabase serves the `public` schema through its REST and GraphQL API to anyone with the publishable key. ClothSeeker never uses that API for data; all access goes through server-side Prisma, which connects as the table owner. The migration `…_enable_rls` turns RLS on for every table **with no policies**, so the `anon` and `authenticated` API roles can read and write nothing.

**Every migration that creates a table must also run `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.** Three checks catch a missed table:
- `pnpm db:check` (local database)
- `tests/integration/rls.test.ts` (test database, CI)
- the manual probe in [testing.md](testing.md#rls-probe)

## Seed data

`pnpm db:seed` ([`prisma/seed.ts`](../../prisma/seed.ts), data in [`prisma/seed-data.ts`](../../prisma/seed-data.ts)) is idempotent. It creates:
- 1 admin and 3 customers (Supabase Auth users plus `User` rows)
- 5 categories
- 15 active dresses and 1 draft
- 145 variants, about 10% sold out
- 5 active customization templates

Prices are ৳1,800–৳9,500, with an XL/XXL surcharge.
