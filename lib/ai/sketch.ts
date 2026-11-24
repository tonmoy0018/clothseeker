// A customer's drawing of a garment, turned into a realistic photo of it by an image model, so it can be
// made into their own dress like a photo (lib/own-dress). The request every sketch renderer sends (in
// lib/ai/providers): what to draw is fixed here; the customer's note only describes the fabric and colours.

/** The longest note kept: a few words on fabric and colours. */
export const SKETCH_NOTE_MAX = 200;

/**
 * The customer's note as it goes into a prompt: letters, numbers and plain punctuation only, on one line,
 * at most SKETCH_NOTE_MAX characters; null when nothing is left.
 */
export function cleanSketchNote(note: string | null | undefined): string | null {
  const cleaned = (note ?? "")
    .replace(/[^\p{L}\p{N} ,.'&/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SKETCH_NOTE_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** The instruction for turning a sketch into a product photo, with the customer's note as a quoted description. */
export function sketchPrompt(note: string | null): string {
  const cleaned = cleanSketchNote(note);
  return [
    "This is a designer's sketch of a garment. Make a realistic e-commerce product photo of that garment as a tailor would make it from the sketch.",
    "Follow the sketch exactly: its cut, length, neckline, sleeves, proportions, seams, and every detail drawn (pleats, ruffles, buttons, embroidery, prints). Do not add, remove or redesign anything, and add no text or logos.",
    cleaned
      ? `The customer describes the fabric and colours as: "${cleaned}". Use that only for the fabric, colours and finish.`
      : "Where the sketch shows colours, use them; otherwise make it in a plain natural fabric in a soft neutral colour.",
    "Show only that garment, front view, centred, upright, filling most of the picture, worn by an invisible ghost mannequin so the neck opening is empty: no person, no skin, no visible mannequin, no hanger, no stand, no other clothes, no pencil lines.",
    "Plain light grey studio background (#f1f0ed), soft even studio light, sharp, portrait 3:4.",
  ].join(" ");
}
