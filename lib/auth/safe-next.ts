// Prevents open redirects through ?next=…: only same-site absolute paths are allowed.

const FALLBACK = "/";

export function safeNextPath(value: unknown, fallback: string = FALLBACK): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return fallback;
  }
  // Must start with a single "/" — rejects "//evil.com", "/\evil.com", "http:", "javascript:".
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (/[\u0000-\u001f\\]/.test(value)) {
    return fallback;
  }
  try {
    const url = new URL(value, "http://clothseeker.invalid");
    if (url.origin !== "http://clothseeker.invalid") {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
