# Order lifecycle

## From cart to paid order

```
Cart ──Checkout──▶ placeOrder ──▶ PENDING_PAYMENT order ──redirect──▶ payment gateway (MockPay)
                    │  re-price, re-validate designs           │
                    │  render preview + 300 DPI print files    │  Pay / Decline
                    │  reserve stock (one transaction)         ▼
                    │  create Payment                     signed webhook ─▶ /api/payments/mock/webhook
                    ▼                                                          │
               expires in 30 min ◀── worker sweep                handlePaymentWebhook (idempotent)
                                                                 ├─ succeeded → PAID
                                                                 ├─ failed    → CANCELLED + restock
                                                                 └─ succeeded after expiry → auto refund
```

- **`placeOrder`** ([`lib/orders/checkout.ts`](../../lib/orders/checkout.ts)) is idempotent per checkout key. The checkout page renders a fresh key, so double clicks, retries or the back button resume the same order and payment. It re-prices everything on the server: ready-made items from the current variant price, custom designs re-validated against the live template. A custom item's DesignSpec, preview and print files are **frozen** on the `OrderItem` (`designSpec`, `previewKey`, `printFiles`) under `design-assets/{customerId}/orders/`.
- **The cart is kept** until payment succeeds. Then only the ordered lines are removed.
- **Unpaid orders** hold their stock for **30 minutes** (`expiresAt`). After that `expireStalePendingOrders` ([`lib/orders/expiry.ts`](../../lib/orders/expiry.ts)) cancels them, restocks, and deletes their rendered files. It runs on every worker poll and at checkout for the customer's own orders, and it's safe to run repeatedly.

## Webhook rules ([`lib/orders/payments.ts`](../../lib/orders/payments.ts))

| Situation | Result |
|---|---|
| Bad signature or malformed body | **400**, nothing changes |
| Unknown payment reference or amount/currency mismatch | **400**, nothing changes |
| Same `eventId` again (gateway retry) | **200** `duplicate`, nothing changes |
| Another "succeeded" event for an already-paid payment | **200** `ignored` |
| `payment.succeeded` for a pending order | Order **PAID**; items **PAID**; custom items → **AWAITING_ACCEPTANCE** with `acceptBy = paidAt + 24 h`; quote items → **ACCEPTED**; designs → `ORDERED`; ordered cart lines removed |
| `payment.failed` | Order and items **CANCELLED**, stock returned, files deleted, cart kept |
| `payment.succeeded` for an order that already expired or was cancelled | Payment **REFUNDED** through the provider; the order stays cancelled; the timeline notes it |

Duplicate events are blocked by the unique `PaymentEvent.eventId`. Concurrent deliveries lose the race on that constraint and return `duplicate`.

## Item state machine ([`lib/orders/transitions.ts`](../../lib/orders/transitions.ts))

**Every** change to `OrderItem.status` goes through `transitionItems()`. It checks the move against this table (including **who** may make it), guards each update on the current status, and writes an `OrderEvent`.

| Kind | From → To | Who |
|---|---|---|
| all | PENDING_PAYMENT → PAID / CANCELLED | SYSTEM (payment) |
| Ready-made | PAID → READY_TO_SHIP / REFUNDED | ADMIN |
| Custom | PAID → AWAITING_ACCEPTANCE | SYSTEM |
| Custom | AWAITING_ACCEPTANCE → ACCEPTED | ADMIN |
| Custom | AWAITING_ACCEPTANCE → REFUNDED | ADMIN (decline) or SYSTEM (24 h timeout, Phase 5) |
| Quote | PAID → ACCEPTED | SYSTEM (price already agreed, Phase 7) |
| Custom, Quote | ACCEPTED → IN_PRODUCTION → QC_SUBMITTED → READY_TO_SHIP (QC_SUBMITTED → IN_PRODUCTION if QC fails) | ADMIN |
| all | READY_TO_SHIP → SHIPPED | ADMIN |
| all | SHIPPED → DELIVERED | COURIER or ADMIN |
| all | DELIVERED → DISPUTED | CUSTOMER |
| all | DISPUTED → REFUNDED / DELIVERED | ADMIN |

CANCELLED and REFUNDED are final. `HAPPY_PATH` lists each kind's normal sequence for the progress stepper on the order page. The order-level `Order.status` tracks payment only: PENDING_PAYMENT, PAID, CANCELLED, REFUNDED.

## After payment (Phase 5)

Acceptance, the 24-hour automatic refund, production, QC, shipping and courier updates are described in [production.md](production.md). All of them go through the same state machine.

## Customer pages

- `/checkout`: address (BD mobile number required), delivery zone (Inside Dhaka ৳80, Outside Dhaka ৳150), server-priced summary.
- `/account/orders` and `/account/orders/[id]`: per-item progress, design previews, address, totals, and the event timeline. "Complete payment" appears while the order is payable.
