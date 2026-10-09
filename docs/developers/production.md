# Production flow (the ClothSeeker team)

Services in [`lib/production/`](../../lib/production/). Every action requires an admin, validates input with Zod, moves items **only** through `transitionItems()` (via `moveItemAsAdmin`), and writes an `AuditLog` row in the same transaction.

## Item journeys

```
Ready-made: PAID ──Mark ready──▶ READY_TO_SHIP ──Ship──▶ SHIPPED ──courier──▶ DELIVERED
Custom:     AWAITING_ACCEPTANCE ──Accept──▶ ACCEPTED ──Start production──▶ IN_PRODUCTION
              │  Decline (reason)         ──front + back QC photos, Submit QC──▶ QC_SUBMITTED
              │  or 24 h passed           ──Approve──▶ READY_TO_SHIP   (Reject → IN_PRODUCTION, new photos needed)
              ▼                                      ──Ship──▶ SHIPPED ──courier──▶ DELIVERED
           REFUNDED (full, automatic)
```

## Acceptance and refunds

- **Accept** works only before `acceptBy` (paid time + 24 h).
- **Decline** (with a reason the customer sees) and the **24-hour timeout** (`expireOverdueAcceptances`, SYSTEM actor) both move the item to REFUNDED and refund it in full. This is the policy recorded in `CLAUDE.md`. The timeout runs on every worker poll and whenever `/admin/orders` loads.
- Refunds ([`refunds.ts`](../../lib/production/refunds.ts)):
  1. `planItemRefunds` writes `PENDING` `Refund` rows in the same transaction as the status change. `uniqueKey` (`item:<id>`, `delivery:<paymentId>`) ensures each item, and each delivery fee, is refunded once.
  2. When no item of the order is left to fulfil, the **delivery fee** is refunded too, and the order becomes **REFUNDED**.
  3. `settleRefunds` calls the payment provider after commit. If it fails, the row stays `PENDING` and `retryPendingRefunds` (worker) finishes it.

## QC

QC photos are stored in the **private** `qc-photos` bucket under `{orderId}/qc/`, processed like every upload (real image check, re-encoded, metadata stripped). **Submit QC** requires a front **and** a back photo taken **after the item last entered production**, so a rejected garment needs fresh photos.

## Shipping and courier

- **Ship with Mock Courier** creates the item's `Shipment` with a tracking number (`MCK` + 10 characters, unique) and moves it to SHIPPED.
- Status updates arrive at `POST /api/couriers/mock/webhook`, signed with HMAC-SHA256 (`MOCK_COURIER_WEBHOOK_SECRET`). [`handleCourierWebhook`](../../lib/production/shipping.ts):
  - dedupes on `CourierEvent.eventId`
  - only moves statuses forward (a late "in transit" is kept in the history but doesn't rewind)
  - on `delivered`, moves the item to DELIVERED as the **COURIER** actor
- The admin order page's "Simulate courier" buttons sign events and POST them to that endpoint, like a real courier would.

## Documents

| Document | Route (admin only, `no-store`) | Contents |
|---|---|---|
| **Spec sheet** (A4) | `/admin/orders/[id]/items/[itemId]/spec-sheet` | Order number, item id, garment, size, quantity, style options, colours per part (name + hex), patterns, every placement (text and font, decorations, images), print files (area, cm, px), the approved design preview, the customer note, and a QR code to the admin order page. **No name, address, phone or email.** |
| **Shipping label** (4 × 6 in) | `/admin/orders/[id]/items/[itemId]/label` | Carrier, tracking number (with QR code), recipient name, address and mobile number, order number. Marked "placeholder". |

PDFs are built with `pdf-lib` using the standard Helvetica font, which only covers Latin characters. `pdfSafe()` maps "৳" to "BDT" and replaces unsupported characters (e.g. Bangla) with "?". Unit tests decompress the PDFs and assert on the drawn text, including that the spec sheet contains no contact details.

## Privacy

The admin order page shows the delivery address for packing. The phone number appears only on the shipping label. Customer notes go on the spec sheet, and the checkout tells customers not to put personal details in them.
