// Daily AI limits. Days follow Bangladesh time (Asia/Dhaka, UTC+6, no daylight saving).

export const DAILY_ROUND_LIMIT = 10;
/** Submissions per day, including ones that fail, so failures can't be used to hammer providers. */
export const DAILY_SUBMISSION_LIMIT = 30;

export const QUOTA_MESSAGE = `You've used today's ${DAILY_ROUND_LIMIT} AI design rounds. They reset at midnight (Dhaka time).`;
export const SUBMISSION_LIMIT_MESSAGE = "You've tried a lot of AI rounds today. Please come back tomorrow.";

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the current Dhaka calendar day, as a UTC instant. */
export function startOfDhakaDay(now: Date): Date {
  const local = now.getTime() + DHAKA_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - DHAKA_OFFSET_MS);
}

export type AiQuota = { used: number; limit: number; remaining: number };

export function quotaFrom(used: number): AiQuota {
  return { used, limit: DAILY_ROUND_LIMIT, remaining: Math.max(0, DAILY_ROUND_LIMIT - used) };
}
