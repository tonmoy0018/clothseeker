# Managing the catalog (ClothSeeker team)

Sign in with an admin account and open **Admin** in the header, or go to `/admin`.

## Add a new dress

1. Go to **Products → New dress**.
2. Enter the **Name**, choose a **Category** and write a **Description**. The **Web address (slug)** is generated from the name if you leave it empty.
3. Click **Create draft**. Drafts are never visible in the shop.
4. Under **Sizes and colors**, add each size/color you sell. For each one, pick a **Size**, type a **Color name**, pick the **Swatch** color, then enter the **Price (৳)** and **Stock** and click **Add**.
5. Under **Photos**, click **Choose File** and then **Upload**. Use JPEG, PNG or WebP, up to 4 MB and at least 600×600 px. The first photo is the cover. Use **Make cover** to change it.
6. Click **Publish**. The dress now appears in the shop. [screenshot: product editor with Publish button]

**If Publish shows an error**, the dress needs at least one active size/color with a price.

## Change prices or stock

On the dress page, edit **৳** and **Stock** in the row and click **Save**. To stop selling a size/color, untick **Active**. Rows are never deleted, so past orders stay correct.

## Hide a dress

- **Unpublish** returns the dress to draft.
- **Archive** retires it.

Either way it disappears from the shop immediately. Customers who already ordered it are not affected.

## Let customers design a dress (templates)

1. On the dress page, click **Enable customization**, then **Edit template**.
2. **Garment images:** upload a plain **front** and **back** image of the dress (at least 800×800 px).
3. **Placement areas:** these are where customers may add text, images and decorations.
   - Select an area, then drag on the garment to draw it, or drag inside it to move it.
   - Enter its real printable **Width (cm)** and **Height (cm)**.
4. **Recolorable regions:** the parts customers can color separately, such as Bodice or Skirt.
5. **Style options:** neckline, sleeve length and dress length, each with an optional **Add-on ৳** price and a **reference image**.
6. **Allowed colors**, **Patterns**, **Fonts** and **Add-on prices**.
7. Click **Save template**, then tick **Live for customers**.

**If going live is refused**, the template needs a front garment image (and a back image if it has back areas), and at least one recolorable region.

**If someone else saved the template at the same time**, you'll see "Someone else saved this template meanwhile". Reload the page; your unsaved changes are lost.

## Notes

- Every change here is recorded in the audit log: who changed what and when. Only field names are stored, never personal data.
- Clothing brand logos must never appear in photos, templates or reference images.
