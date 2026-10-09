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

## Tailoring quotes (Phase 7)

```
REQUESTED ──team prices it (within 24 h)──▶ QUOTED ──paid (within 7 days)──▶ ACCEPTED
    │                                          │
    ├─team declines──▶ DECLINED                ├─customer: "No thanks" ─▶ WITHDRAWN
    ├─customer withdraws──▶ WITHDRAWN          └─7 days pass ──────────▶ EXPIRED (cart line removed)
    └─24 h pass with no reply──▶ EXPIRED
```

- **Eligibility** (`quoteIneligibility`, `lib/quotes/rules.ts`): the customer's own **saved** design, started from a dress photo (`startedFrom = PHOTO` with a reference photo), with no open quote, and at most 5 open quotes per customer.
- **Requesting** freezes the design (`specSnapshot`) and renders its own preview, so later edits to the design don't change what was quoted.
- **Expiry** is enforced twice: `effectiveQuoteStatus` treats overdue rows as expired immediately (pages, accept, checkout, the team's reply), and the worker's `expireQuotes` sweep (also run when `/admin/quotes` loads) writes it and removes expired quote lines from carts.
- **Accepting** adds a `QUOTE` cart line. The price always comes from the quote. Checkout re-checks that the quote is still `QUOTED`, unexpired and owned, then renders print files from the snapshot.
- **Payment:** the webhook moves the item `PAID → ACCEPTED` (SYSTEM) and the quote to `ACCEPTED` in the same transaction, including when the price expired while the payment was in flight (the amount was locked when the order was placed).

## Disputes (Phase 8)

```
DELIVERED ──customer reports a problem (≤ 14 days, once)──▶ DISPUTED ──team: refund──▶ REFUNDED
                                                                 └──team: no refund──▶ DELIVERED
```

- `openDispute` (`lib/disputes/service.ts`) checks the customer owns the item, that it's DELIVERED, the window (from its latest DELIVERED event) and that no earlier dispute exists. It stores up to 3 re-encoded photos and moves the item with `transitionItems` (CUSTOMER) in the same transaction as the `Dispute` row.
- `resolveDispute` (`lib/admin/disputes.ts`) goes through `moveItemAsAdmin`. A refund uses `planItemRefunds` in the transaction and `settleRefunds` after commit, so each item is refunded once (`uniqueKey`).
