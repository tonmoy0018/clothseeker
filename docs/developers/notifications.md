# Customer emails

Customers get an email when something happens to their order or quote. Emails use an **outbox**: they're queued in the same database transaction as the event and sent by the worker.

```
event (payment, team action, courier, sweep) ──same transaction──▶ notifications (QUEUED, uniqueKey)
worker sweep sendQueuedEmails ──claim QUEUED→SENDING──▶ render from current data ──▶ EmailProvider ──▶ SENT
                                                   └─ failure: retry in 1, 4 min… then FAILED (3 attempts)
```

## Which emails

| Kind | Queued by | Sent when |
|---|---|---|
| `ORDER_CONFIRMED` | `handlePaymentWebhook` | payment received |
| `DESIGN_ACCEPTED` | `transitionItems` | custom item AWAITING_ACCEPTANCE → ACCEPTED |
| `ITEM_REFUNDED` | `transitionItems` | → REFUNDED (team decline, 24 h timeout) |
| `SHIPPED` / `DELIVERED` | `transitionItems` | → SHIPPED / → DELIVERED (team or courier) |
| `DISPUTE_REFUNDED` / `DISPUTE_CLOSED` | `transitionItems` | DISPUTED → REFUNDED / → DELIVERED |
| `QUOTE_READY` / `QUOTE_DECLINED` | `respondToQuote` | the team replies |
| `QUOTE_EXPIRED` | `expireQuotes` | no reply in 24 h, or price not paid in 7 days |

The item rules are pure (`lib/notifications/rules.ts`). Because the hook lives in `transitionItems`, every path that moves an item (team, system sweeps, courier webhook) emails consistently. Items moved together in one call produce one email.

## Guarantees

- **Never lost, never for a rolled-back event:** the row is written in the event's transaction (tested).
- **Never twice:** `uniqueKey` (e.g. `SHIPPED:<order>:<item ids>`, `QUOTE_READY:<quote>`) ignores duplicates such as webhook retries, and the sender claims each row with a guarded update, so two workers can't both send it (tested).
- **Privacy:**
  - The outbox stores ids only.
  - The email is rendered at send time from current data (`lib/notifications/templates.ts`): first name, order number, product names, tracking number, quote price, the team's note and a link. **Never an address, phone or image.**
  - It goes to the account's current email address.
  - Logs carry the notification id, kind and error name only.

## Providers (worker env)

| `EMAIL_PROVIDER` | What |
|---|---|
| `log` (default) | Sends nothing (only the worker log line). Use when you don't want emails. |
| `smtp` | Any SMTP server via `SMTP_URL` (nodemailer). |

**Locally**, `pnpm env:local` sets `EMAIL_PROVIDER=smtp` and `SMTP_URL=smtp://127.0.0.1:55425`, which is **Mailpit**, the test inbox built into the local Supabase stack. Nothing leaves your machine. Open the inbox at **http://127.0.0.1:55424**. The SMTP port is enabled in `supabase/config.toml` (`[local_smtp] smtp_port = 55425`).

Other settings: `EMAIL_FROM` (default `ClothSeeker <orders@clothseeker.test>`) and `NEXT_PUBLIC_APP_URL` (used for links; default `http://localhost:3000`).

**Production (Phase 9):** set `SMTP_URL` to a transactional email service with a free tier, e.g. Resend (100/day) or Brevo (300/day), and `EMAIL_FROM` to an address on a domain verified with that service.

## Tests

- `tests/unit/notification-rules.test.ts`: which moves email, unique keys, every template renders and escapes HTML, no address/phone fields.
- `tests/integration/notifications.test.ts`: queued once with the event (webhook retry, rollback), the right kinds for declines, disputes and quotes, sending once with current data, retries then FAILED, two concurrent senders.
- `tests/e2e/emails.spec.ts` (`@supabase`): an order and shipment produce the two emails in Mailpit (checked through Mailpit's API).
