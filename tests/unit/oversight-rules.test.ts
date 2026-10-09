import { describe, expect, it } from "vitest";

import { averageMs, dailyCounts, failureRate, topCounts } from "@/lib/admin/ai-metrics";
import { auditTargetHref } from "@/lib/admin/audit-log";
import { AI_FAILURE_MESSAGES } from "@/lib/ai/errors";
import { photoProblem } from "@/lib/ai/worker/try-on";
import { DISPUTE_WINDOW_DAYS, disputeDeadline, disputeIneligibility } from "@/lib/disputes/rules";

const DAY = 24 * 60 * 60 * 1000;

describe("dispute eligibility", () => {
  const deliveredAt = new Date("2026-10-01T10:00:00Z");
  it(`allows one report within ${DISPUTE_WINDOW_DAYS} days of delivery`, () => {
    expect(disputeIneligibility({ status: "DELIVERED", deliveredAt, earlierDisputes: 0 }, new Date(deliveredAt.getTime() + 13 * DAY))).toBeNull();
    expect(disputeIneligibility({ status: "DELIVERED", deliveredAt, earlierDisputes: 0 }, new Date(deliveredAt.getTime() + 14 * DAY + 1))).toMatch(/within 14 days/);
    expect(disputeIneligibility({ status: "DELIVERED", deliveredAt, earlierDisputes: 1 }, deliveredAt)).toMatch(/already reported/);
    expect(disputeIneligibility({ status: "SHIPPED", deliveredAt: null, earlierDisputes: 0 }, deliveredAt)).toMatch(/once the item has been delivered/);
    expect(disputeIneligibility({ status: "DISPUTED", deliveredAt, earlierDisputes: 0 }, deliveredAt)).toMatch(/once the item has been delivered/);
    expect(disputeDeadline(deliveredAt).toISOString()).toBe("2026-10-15T10:00:00.000Z");
  });
});

describe("AI metric calculations", () => {
  it("averages, failure rates, daily buckets and top codes", () => {
    expect(averageMs([])).toBeNull();
    expect(averageMs([1000, 2000, 4000])).toBe(2333);
    expect(failureRate(0, 0)).toBeNull();
    expect(failureRate(3, 1)).toBe(0.25);
    const now = new Date("2026-10-10T06:00:00Z"); // 12:00 in Dhaka
    const series = dailyCounts([new Date("2026-10-10T01:00:00Z"), new Date("2026-10-09T17:59:00Z"), new Date("2026-10-09T18:00:00Z"), new Date("2026-09-01T00:00:00Z")], now, 3);
    expect(series.map((s) => s.count)).toEqual([0, 1, 2]);
    expect(series.at(-1)?.day.toISOString()).toBe("2026-10-09T18:00:00.000Z");
    expect(topCounts(["A", "B", "A", null], 2)).toEqual([
      { value: "A", count: 2 },
      { value: "B", count: 1 },
    ]);
  });
});

describe("try-on photo problems", () => {
  const ok = { onePerson: true, facingForward: true, goodLight: true, bodyVisible: true };
  it("names the first check that failed, each with its own message", () => {
    expect(photoProblem({ ...ok, bodyVisible: false })).toBe("PHOTO_BODY_NOT_VISIBLE");
    expect(photoProblem({ ...ok, goodLight: false, bodyVisible: false })).toBe("PHOTO_TOO_DARK");
    expect(photoProblem({ ...ok, facingForward: false })).toBe("PHOTO_NOT_FACING");
    expect(photoProblem({ ...ok, onePerson: false })).toBe("PHOTO_NOT_ONE_PERSON");
    expect(AI_FAILURE_MESSAGES.PHOTO_BODY_NOT_VISIBLE).toMatch(/shoulders to your knees/);
  });
});

describe("audit links", () => {
  it("links targets the team can open", () => {
    expect(auditTargetHref("order_item", "i1", [["orderId", "o1"]])).toBe("/admin/orders/o1#item-i1");
    expect(auditTargetHref("quote_request", "q1", [])).toBe("/admin/quotes/q1");
    expect(auditTargetHref("dispute", "d1", [])).toBe("/admin/disputes/d1");
    expect(auditTargetHref("try_on_media", null, [])).toBeNull();
  });
});
