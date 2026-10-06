# Permissions matrix

ClothSeeker has two roles: **customer** and **admin** (the ClothSeeker team). Visitors who aren't signed in are "anonymous".

Authorization always happens on the server:
- [`lib/auth/guards.ts`](../../lib/auth/guards.ts): `requireUser`, `requireAdmin` for pages and actions.
- [`lib/auth/policy.ts`](../../lib/auth/policy.ts): pure rules (`assertCustomer`, `assertOwns`, `assertAdmin`) used by domain services.

Hiding a button in the UI is never the access control. The role is read from the `users` table on every request, never from the JWT or the client.

## Implemented (Phase 1)

| Action | Anonymous | Customer | Admin | Enforced in |
|---|---|---|---|---|
| Browse home, listing, product pages (active products only) | ✅ | ✅ | ✅ | `lib/shop/catalog.ts` (filters `status = ACTIVE`) |
| See draft or archived products | ❌ | ❌ | ❌ (admin catalog in Phase 2) | `catalog.ts` |
| Sign up (always creates a customer) | ✅ | n/a | n/a | `app/(shop)/auth-actions.ts` |
| Buy now / add to cart | ➡️ sign in | ✅ own cart | ❌ "admin accounts can't shop" | `addToCart` → `assertCustomer` |
| View, update or remove cart lines | ➡️ sign in | ✅ **own lines only** | ❌ | `findOwnedItem` (scoped by `cart.customerId`) |
| Mock pay / create order | ➡️ sign in | ✅ own cart | ❌ | `payWithMock` → `assertCustomer`; key owner check |
| List orders | ➡️ sign in | ✅ **own orders only** | (Phase 4/5) | `listOrders` (scoped by `customerId`) |
| Open `/admin` | 404 | 404 | ✅ | `requireAdmin()` on every admin page |

➡️ means "redirected to `/login?next=…`". `next` is sanitized by [`safeNextPath`](../../lib/auth/safe-next.ts) to prevent open redirects.

**Not-found instead of forbidden.** When a customer targets another customer's cart line or checkout key, the service responds as if the record doesn't exist. That way it doesn't reveal that the record exists.

## Planned

| Phase | Admin | Customer |
|---|---|---|
| 2 | Manage products, variants, stock, templates, product photos | — |
| 3 | — | Create, save and price their own designs |
| 4 | View all orders | Order detail and tracking for their own orders |
| 5 | Accept custom orders, spec sheets, QC photos, shipping | — |
| 6 | AI metrics | AI rounds on their own designs (10/day) |
| 7 | Answer quote requests | Try-on (with consent), request and accept quotes |
| 8 | Brand-logo flags, disputes, audit log | Open disputes on their own order items |

Every sensitive admin mutation will write an `AuditLog` row (Phase 2 onwards).

## Tests

- Unit: `tests/unit/auth-policy.test.ts`, `tests/unit/safe-next.test.ts`.
- Integration (real DB): `tests/integration/cart.test.ts` and `checkout.test.ts` cover:
  - cross-customer access
  - admins not being able to shop
  - checkout-key reuse by another customer
- E2E: `tests/e2e/buy-now.spec.ts` checks that one customer can't see another's orders and that `/admin` returns 404 for customers.
