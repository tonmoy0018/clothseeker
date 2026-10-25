# Managing the catalog (ClothSeeker team)

Sign in with an admin account and open **Admin** in the header, or go to `/admin`.

## Add a new item

1. Go to **Products → New item**.
2. Enter the **Name**, choose the **Garment type** (women's dress, men's shirt or men's panjabi), choose a **Category** and write a **Description**. The garment type decides where it appears in the shop (Women or Men), its size chart, and the style choices customers get when designing it (a dress: neckline, sleeves, length; a shirt: collar, sleeves, fit; a panjabi: collar, sleeves, length). Once an item has a customization template, its garment type can't change. The **Web address (slug)** is generated from the name if you leave it empty.
3. Click **Create draft**. Drafts are never visible in the shop.
4. Under **Sizes and colors**, add each size/color you sell. For each one, pick a **Size**, type a **Color name**, pick the **Swatch** color, then enter the **Price (৳)** and **Stock** and click **Add**.
5. Under **Photos**, click **Choose File** and then **Upload**. Use JPEG, PNG or WebP, up to 4 MB and at least 600×600 px. The first photo is the cover. Use **Make cover** to change it.
6. Click **Publish**. The item now appears in the shop. [screenshot: product editor with Publish button]

**If Publish shows an error**, the item needs at least one active size/color with a price.

## Change prices or stock

On the dress page, edit **৳** and **Stock** in the row and click **Save**. To stop selling a size/color, untick **Active**. Rows are never deleted, so past orders stay correct.

## Hide a dress

- **Unpublish** returns the dress to draft.
- **Archive** retires it.

Either way it disappears from the shop immediately. Customers who already ordered it are not affected.

## Let customers design their own (templates)

1. On the item's page, click **Enable customization**, then **Edit template**. The template starts with the garment type's own style choices, parts (e.g. body, sleeves, collar for shirts) and print areas.
2. **Garment images:** upload a plain **front** and **back** image of the dress (at least 800×800 px). The demo dresses also have **style pictures**: a drawing for every neckline, sleeve and length, so the customer's preview changes shape as they choose. Style pictures replace the garment images whenever they match the customer's choices, so if you upload your own garment images for one of these dresses, press **Remove style pictures**.
3. **Placement areas:** these are where customers may add text, images and decorations.
   - Select an area, then drag on the garment to draw it, or drag inside it to move it.
   - Enter its real printable **Width (cm)** and **Height (cm)**.
3b. **Trim to the fabric:** tick this on a large area (a whole part or the whole front) so customers can place items anywhere in it; anything that falls off the garment (by its masks) isn't printed. The demo items use it for Whole front, Bodice, Skirt, Sleeves and Whole back.
4. **Recolorable regions:** the parts customers can color separately, such as Bodice or Skirt. Each region needs a **mask**: an image the same size as the garment image, black everywhere except the region, which is painted white. Upload a **front mask** and/or **back mask** for each region. Customers can only recolor regions that have masks, and the template can't go live until every recolorable region has one.
5. **Style options:** neckline, sleeve length and dress length, each with an optional **Add-on ৳** price and a **reference image**.
6. **Allowed colors**, **Patterns**, **Fonts** and **Add-on prices**.
7. Click **Save template**, then tick **Live for customers**.

**If going live is refused**, the template needs a front garment image (and a back image if it has back areas), and at least one recolorable region.

**If someone else saved the template at the same time**, you'll see "Someone else saved this template meanwhile". Reload the page; your unsaved changes are lost.

## Notes

- Every change here is recorded in the audit log: who changed what and when. Only field names are stored, never personal data.
- Clothing brand logos must never appear in photos, templates or reference images.
