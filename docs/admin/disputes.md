# Handling disputes (ClothSeeker team)

A customer can **report a problem** with an item within **14 days of delivery**, from their order page. They describe what's wrong and can add up to 3 photos. The item then shows as **Disputed**.

Open **Admin → Disputes**; the dashboard tile "Open disputes" shows how many are waiting. Each dispute page shows only what you need to decide:

- the customer's report and photos
- what was ordered: the approved design and print files for custom items, size, colour and price
- **our QC photos** from before shipping
- the item's full timeline, including the courier updates

There's no address or phone number on this page. If you need them, use **Open the order**.

## Deciding

Write a short note for the customer (they see it on their order page), then choose:

- **Refund:** the item's price is refunded in full, automatically. If it was the only item still in the order, the delivery fee is refunded too.
- **No refund:** the item goes back to *Delivered*. Explain why in the note (for example, that the QC photos match the design).

You can decide only once, and each decision is recorded in the audit log. A customer can report only one problem per item.

The 14-day window is a setting in `lib/disputes/rules.ts`. Ask a developer to change it.
