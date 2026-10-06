import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/auth/safe-next";

describe("safeNextPath", () => {
  it.each([
    ["/cart", "/cart"],
    ["/products/linen-wrap-dress", "/products/linen-wrap-dress"],
    ["/products?size=M&color=Sage", "/products?size=M&color=Sage"],
  ])("keeps same-site path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "cart",
    "",
    "/a\nb",
    undefined,
    ["/cart"],
    "/" + "a".repeat(600),
  ])("rejects %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it("uses the provided fallback", () => {
    expect(safeNextPath("//evil", "/admin")).toBe("/admin");
  });
});
