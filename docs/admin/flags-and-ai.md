# Logo flags, AI health and the audit log (ClothSeeker team)

## Brand-logo flags (Admin → Flags)

When a customer uploads a photo for the AI design box, to start a design, or for try-on, the AI checks it for clothing brand logos. If it finds one, the customer is told the photo can't be used, and the photo is flagged here for you.

- **Confirm logo (delete photo):** you agree it's a brand logo; the photo is deleted.
- **Dismiss — false alarm:** the AI was wrong; the flag is closed and the photo is kept.

Each card shows a short customer reference (the start of their id), so you can spot someone uploading logos repeatedly, without showing any personal details. Every decision is recorded in the audit log.

## AI health (Admin → AI)

- **Worker status:** whether the background worker is running and which AI services it uses. If it says *Worker stopped*, no AI requests are being processed: start it on the Mac mini with `pnpm worker`.
- **Per feature** (AI design rounds, start from photo/description, try-on):
  - today's requests, completed and failed
  - the queue right now
  - **average wait** (how long requests sat in the queue) and **average run time**
  - the **failure rate**, with the most common reasons
  - a 14-day chart
- **Daily-limit hits:** how often customers were turned away because they'd reached a daily limit (10 AI rounds, 5 try-ons, 30 AI requests). Many hits may mean the limits are too low.

**Common failure reasons:**

| Code | Meaning |
|---|---|
| `PROVIDER` | The free AI service was busy or down |
| `TIMEOUT` | It took too long |
| `TRYON_LIMIT` | The free try-on service's daily allowance ran out |
| `BRAND_LOGO` | A logo was found (see Flags) |
| `PHOTO_…` | The customer's try-on photo didn't work |

## Audit log (Admin → Audit)

Every sensitive action, with who did it and when:
- catalog and template changes
- every order step (accept, decline, QC, shipping)
- quotes, disputes and flags
- customers deleting try-on photos
- the system's automatic clean-ups

Filter by action (e.g. `quote.`), target, who, or dates. Team members are named; customers are only shown as "Customer". Details contain ids, counts and statuses, never personal data.
