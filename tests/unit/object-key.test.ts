import { describe, expect, it } from "vitest";

import { BUCKETS } from "@/lib/storage/buckets";
import { assertSafeObjectKey, buildObjectKey, InvalidObjectKeyError } from "@/lib/storage/object-key";

const OWNER = "3f2b8a52-6c1e-4b7a-9d0f-1a2b3c4d5e6f";
const FIXED_ID = "11111111-2222-4333-8444-555555555555";

describe("buildObjectKey", () => {
  it("builds owner/category/id.ext keys", () => {
    const key = buildObjectKey(
      BUCKETS.productMedia,
      { ownerId: OWNER, category: "products", extension: ".JPG" },
      () => FIXED_ID,
    );
    expect(key).toBe(`${OWNER}/products/${FIXED_ID}.jpg`);
  });

  it("generates a unique id by default", () => {
    const input = { ownerId: OWNER, category: "products", extension: "png" };
    expect(buildObjectKey(BUCKETS.productMedia, input)).not.toBe(buildObjectKey(BUCKETS.productMedia, input));
  });

  it.each([
    ["traversal in category", { ownerId: OWNER, category: "../other", extension: "png" }],
    ["slash in category", { ownerId: OWNER, category: "a/b", extension: "png" }],
    ["non-uuid owner", { ownerId: "../../etc", category: "products", extension: "png" }],
    ["traversal in extension", { ownerId: OWNER, category: "products", extension: "png/../x" }],
  ])("rejects %s", (_label, input) => {
    expect(() => buildObjectKey(BUCKETS.productMedia, input)).toThrow(InvalidObjectKeyError);
  });

  it("rejects extensions the bucket does not allow", () => {
    expect(() =>
      buildObjectKey(BUCKETS.qcPhotos, { ownerId: OWNER, category: "qc", extension: "pdf" }),
    ).toThrow(InvalidObjectKeyError);
    expect(() =>
      buildObjectKey(BUCKETS.designAssets, { ownerId: OWNER, category: "uploads", extension: "svg" }),
    ).toThrow(InvalidObjectKeyError);
  });
});

describe("assertSafeObjectKey", () => {
  it("accepts generated keys", () => {
    expect(() => assertSafeObjectKey(`${OWNER}/products/${FIXED_ID}.png`)).not.toThrow();
  });

  it.each(["../secret.png", `${OWNER}/../x.png`, `/${OWNER}/a.png`, `${OWNER}/a b.png`, "noext", ""])(
    "rejects %j",
    (key) => {
      expect(() => assertSafeObjectKey(key)).toThrow(InvalidObjectKeyError);
    },
  );
});
