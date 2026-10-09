# Fulfilling orders (ClothSeeker team)

Open **Admin → Orders**. The tabs follow the work:

| Tab | What to do |
|---|---|
| **Needs acceptance** | Custom designs waiting for you. Each shows the time left. **Accept** before the deadline, or **Decline & refund** with a short reason the customer will see. After 24 hours the item is refunded automatically. |
| **To make** | Accepted items: **Start production**, make the garment, then upload a **front** and a **back** QC photo and click **Submit for QC**. |
| **Quality check** | Compare the photos with the design and spec sheet. **Approve QC**, or **Reject QC** with what needs fixing (it goes back to production and needs new photos). |
| **To ship** | Ready-made items: pick from stock, pack, **Mark ready to ship**. Then **Ship with Mock Courier**, for ready-made and approved custom items alike. |
| **Shipped** | Waiting for the courier. Updates arrive automatically; in this prototype use **Simulate courier** (in transit / out for delivery / delivered). |

## On an order page

- **Spec sheet (PDF):** print it for the workshop. It has everything needed to make the garment and a QR code back to the order, but no customer contact details. [screenshot: spec sheet]
- **Print file:** the 300 DPI transparent PNG for each placement area.
- **Shipping label (PDF):** appears once shipped. It's a placeholder for the courier's real label.
- **Payment:** shows refunds (item and, when nothing is left to deliver, the delivery fee).
- **Timeline:** every step with who did it (customer, system, admin, courier).

## Good to know

- Every action is recorded in the audit log.
- You can only take the actions that make sense for the item's current status; anything else is refused with a message.
- Refunds are processed automatically. If one shows "pending", the system retries it.
