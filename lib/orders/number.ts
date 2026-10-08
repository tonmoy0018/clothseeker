import { randomInt } from "node:crypto";

const ORDER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** e.g. CS-20261006-7K3QX. Human-friendly; uniqueness is enforced by the database. */
export function generateOrderNumber(at: Date, random: (max: number) => number = randomInt): string {
  const date = at.toISOString().slice(0, 10).replaceAll("-", "");
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += ORDER_CODE_ALPHABET.charAt(random(ORDER_CODE_ALPHABET.length));
  }
  return `CS-${date}-${code}`;
}
