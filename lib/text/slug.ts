/** "Rose Pink Bodice!" → "rose-pink-bodice". Shared by server and client code. */
export function slugify(value: string, maxLength = 80): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** A slug not already in `taken`, adding -2, -3… when needed. */
export function uniqueSlug(value: string, taken: readonly string[], maxLength = 40): string {
  const base = slugify(value, maxLength - 3) || "item";
  let candidate = base;
  for (let n = 2; taken.includes(candidate); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}
