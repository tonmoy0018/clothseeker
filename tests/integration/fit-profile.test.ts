import { describe, expect, it } from "vitest";

import { ForbiddenError } from "@/lib/auth/policy";
import { deleteBodyProfile, FitProfileError, getBodyProfile, saveBodyProfile } from "@/lib/fit/profile";

import { createUser, db, resetDatabaseBeforeEach } from "./helpers";

// A customer's remembered height and fit preference: kept only when they ask, only theirs.

resetDatabaseBeforeEach();

describe("body profile", () => {
  it("is saved, updated and deleted by its owner only", async () => {
    const ava = await createUser();
    const noah = await createUser();
    expect(await getBodyProfile(db, ava)).toBeNull();
    await saveBodyProfile(db, ava, { heightCm: "162", preference: "fitted" });
    // Anything else sent along (an old client's weight) isn't kept.
    await saveBodyProfile(db, ava, { heightCm: 163, weightKg: 56, preference: "relaxed" });
    expect(await getBodyProfile(db, ava)).toEqual({ heightCm: 163, preference: "relaxed" });
    expect(await db.bodyProfile.count()).toBe(1);
    // Someone else sees and deletes only their own (nothing).
    expect(await getBodyProfile(db, noah)).toBeNull();
    await deleteBodyProfile(db, noah);
    expect(await db.bodyProfile.count()).toBe(1);
    await deleteBodyProfile(db, ava);
    expect(await getBodyProfile(db, ava)).toBeNull();
  });

  it("refuses impossible values and non-customers", async () => {
    const ava = await createUser();
    await expect(saveBodyProfile(db, ava, { heightCm: 400, preference: "regular" })).rejects.toBeInstanceOf(FitProfileError);
    await expect(saveBodyProfile(db, ava, { heightCm: 160, preference: "baggy" })).rejects.toBeInstanceOf(FitProfileError);
    const admin = await createUser("ADMIN");
    await expect(saveBodyProfile(db, admin, { heightCm: 160, preference: "regular" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.bodyProfile.count()).toBe(0);
  });

  it("goes with the account", async () => {
    const ava = await createUser();
    await saveBodyProfile(db, ava, { heightCm: 160, preference: "regular" });
    await db.user.delete({ where: { id: ava.id } });
    expect(await db.bodyProfile.count()).toBe(0);
  });
});
