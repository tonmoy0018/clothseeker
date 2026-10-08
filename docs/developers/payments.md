# Payments

Checkout talks to a **`PaymentProvider`** ([`lib/payments/types.ts`](../../lib/payments/types.ts)) and never to a gateway directly.

```ts
createPayment({ orderId, orderNumber, amountMinor, currency, idempotencyKey, returnUrl }) → { providerRef, redirectUrl }
parseWebhook(rawBody, headers) → { eventId, type: "payment.succeeded" | "payment.failed", providerRef, amountMinor, currency }  // throws WebhookVerificationError
refund(providerRef, amountMinor)
```

## Mock provider (the only one today)

- **`MockPaymentProvider`** ([`lib/payments/mock.ts`](../../lib/payments/mock.ts)) derives `providerRef` from the idempotency key, so a retried checkout never creates a second payment. It redirects to `/mock-gateway/[ref]`.
- **`/mock-gateway/[ref]`** is a page labelled "Simulated payment gateway". Only the payment's owner can open it. **Pay** and **Decline** build the result event, sign it with **HMAC-SHA256** (`MOCK_PAYMENT_WEBHOOK_SECRET`), and POST it to `/api/payments/mock/webhook`. That's the same path and verification a real gateway's server-to-server callback would use.
- Signatures are compared in constant time. Bodies are limited to 64 KB.

## Adding a real sandbox provider (e.g. SSLCommerz or bKash sandbox)

1. Implement `PaymentProvider` in `lib/payments/<name>.ts`:
   - `createPayment` calls the gateway's "create session" API.
   - `parseWebhook` verifies the gateway's signature (or validates the transaction via its API) and maps its payload to the event shape.
2. Add its secrets to `lib/env/schema.ts`, `.env.example` and CI. Add the name to `PAYMENT_PROVIDER`.
3. Return it from `getPaymentProvider()` ([`lib/payments/index.ts`](../../lib/payments/index.ts)).
4. Register the webhook URL `https://<host>/api/payments/<name>/webhook` with the gateway.

Checkout, webhook handling, idempotency and refunds don't change.
