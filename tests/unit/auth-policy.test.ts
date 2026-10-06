import { describe, expect, it } from "vitest";

import { assertAdmin, assertCustomer, assertOwns, ForbiddenError, isAdmin, owns, type Actor } from "@/lib/auth/policy";

const alice: Actor = { id: "11111111-1111-4111-8111-111111111111", role: "CUSTOMER" };
const bob: Actor = { id: "22222222-2222-4222-8222-222222222222", role: "CUSTOMER" };
const admin: Actor = { id: "33333333-3333-4333-8333-333333333333", role: "ADMIN" };

describe("auth policy", () => {
  it("customers own only their own records", () => {
    expect(owns(alice, alice.id)).toBe(true);
    expect(owns(alice, bob.id)).toBe(false);
    expect(() => assertOwns(alice, bob.id)).toThrow(ForbiddenError);
    expect(() => assertOwns(alice, alice.id)).not.toThrow();
  });

  it("admin access is explicit, never implied by ownership checks", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(alice)).toBe(false);
    expect(() => assertOwns(admin, alice.id)).toThrow(ForbiddenError);
    expect(() => assertAdmin(alice)).toThrow(ForbiddenError);
    expect(() => assertAdmin(admin)).not.toThrow();
  });

  it("only customers can shop", () => {
    expect(() => assertCustomer(alice)).not.toThrow();
    expect(() => assertCustomer(admin)).toThrow(ForbiddenError);
  });
});
