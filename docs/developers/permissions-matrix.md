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

## Implemented (Phase 2)

| Action | Anonymous | Customer | Admin | Enforced in |
|---|---|---|---|---|
| Open any `/admin/**` page | 404 | 404 | ✅ | `requireAdmin()` in each page **and** each server action |
| List or see drafts and archived products | ❌ | ❌ | ✅ | `lib/admin/products.ts` → `assertAdmin` |
| Create/edit products, publish, unpublish, archive | ❌ | ❌ | ✅ | `lib/admin/products.ts` |
| Add/edit sizes, colors, prices, stock | ❌ | ❌ | ✅ | `lib/admin/variants.ts` |
| Upload, remove or reorder product photos | ❌ | ❌ | ✅ (only the product's own keys) | `lib/admin/media.ts` |
| Create, edit or activate templates; upload template images | ❌ | ❌ | ✅ (keys must start with the product id) | `lib/admin/templates.ts` |
| Load a template to design with | ✅ live templates of live products only | ✅ same | ✅ same | `lib/catalog/template-loader.ts` |
| Read private images | signed URLs only, for live products | same | signed URLs in admin | `StorageAdapter.signReadUrls` |

Storage buckets are private with no policies, so the publishable key can't list, read or upload.

## Implemented (Phase 3)

| Action | Anonymous | Customer | Admin | Enforced in |
|---|---|---|---|---|
| Open the design screen for a live template | ✅ (can design, not save) | ✅ | ✅ (can't save) | `loadDesignContext` (live product + live template only) |
| Save a design / add it to the cart | ➡️ sign in (draft kept) | ✅ **own designs only** | ❌ | `saveDesign`, `addDesignToCart` → `assertCustomer`, owner-scoped queries |
| Delete a saved design (and its cart line and preview) | ❌ | ✅ own, not once ordered | ❌ | `deleteDesign` |
| Load a saved design in the editor | ❌ | ✅ own only (`?design=` of anyone else is ignored) | ❌ | `getDesignForEdit` (owner + product scoped) |
| Upload an image for a design | ➡️ sign in | ✅ stored under `{customerId}/uploads/` | ❌ | `uploadDesignImage` |
| Use an uploaded image in a design | ❌ | ✅ **own uploads only** | ❌ | `validateDesignAgainstTemplate` (key prefix) |
| See prices | client preview | server recomputes on every save, cart view and checkout | — | `priceDesign` + `checkDesign` |

## Implemented (Phase 4)

| Action | Anonymous | Customer | Admin | Enforced in |
|---|---|---|---|---|
| Check out / place an order | ➡️ sign in | ✅ own cart | ❌ | `placeOrder` → `assertCustomer` |
| Open the simulated gateway for a payment | ➡️ sign in | ✅ own payments only | ❌ | `getPaymentForCustomer` |
| View an order's detail and timeline | ➡️ sign in | ✅ own orders only (404 otherwise) | (Phase 5) | `getOrderForCustomer` |
| Complete a pending payment | ➡️ sign in | ✅ own, while payable | ❌ | `resumePayment` |
| Mark an order paid or cancelled | ❌ | ❌ | ❌ | Only a **signed webhook** (SYSTEM) can; `transitionItems` checks actors |

## Planned

| Phase | Admin | Customer |
|---|---|---|
| 4 | — | — |
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
