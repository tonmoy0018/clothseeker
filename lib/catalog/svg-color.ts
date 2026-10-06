const HEX = /^#[0-9a-f]{6}$/i;

/** Only validated 6-digit hex colors are ever interpolated into SVG markup. */
export function safeHex(color: string): string {
  if (!HEX.test(color)) {
    throw new Error("Invalid color");
  }
  return color.toLowerCase();
}
