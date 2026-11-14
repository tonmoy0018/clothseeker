import { describe, expect, it } from "vitest";

import {
  clientEnvSchema,
  EnvValidationError,
  parseEnv,
  serverEnvSchema,
  workerEnvSchema,
} from "@/lib/env/schema";

const validServerEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder_value",
  SUPABASE_SECRET_KEY: "sb_secret_placeholder_value_0000",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  DIRECT_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  MOCK_PAYMENT_WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
  MOCK_COURIER_WEBHOOK_SECRET: "test-courier-secret-0123456789abcdef",
};

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("env validation", () => {
  it("accepts a complete server env", () => {
    expect(parseEnv(serverEnvSchema, validServerEnv, "server")).toMatchObject(validServerEnv);
  });

  it("reports missing variable names", () => {
    const { SUPABASE_SECRET_KEY: _omitted, ...rest } = validServerEnv;
    const error = captureError(() => parseEnv(serverEnvSchema, rest, "server"));
    expect(error).toBeInstanceOf(EnvValidationError);
    if (error instanceof EnvValidationError) {
      expect(error.invalidKeys).toEqual(["SUPABASE_SECRET_KEY"]);
    }
  });

  it("never includes values in the error message", () => {
    const secret = "postgresql://user:hunter2-very-secret@db/x";
    const env = { ...validServerEnv, DATABASE_URL: secret.replace("postgresql", "mysql") };
    expect(() => parseEnv(serverEnvSchema, env, "server")).toThrow(/DATABASE_URL/);
    expect(() => parseEnv(serverEnvSchema, env, "server")).not.toThrow(/hunter2/);
  });

  it("rejects non-postgres database URLs and non-http app URLs", () => {
    expect(() =>
      parseEnv(serverEnvSchema, { ...validServerEnv, DATABASE_URL: "mysql://x@y/z" }, "server"),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      parseEnv(clientEnvSchema, { ...validServerEnv, NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }, "client"),
    ).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("client schema only contains NEXT_PUBLIC_ variables", () => {
    for (const key of Object.keys(clientEnvSchema.shape)) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(true);
    }
  });

  it("worker poll interval defaults and is bounded", () => {
    expect(parseEnv(workerEnvSchema, validServerEnv, "worker").WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(() =>
      parseEnv(workerEnvSchema, { ...validServerEnv, WORKER_POLL_INTERVAL_MS: "10" }, "worker"),
    ).toThrow(/WORKER_POLL_INTERVAL_MS/);
  });

  it("AI providers default to the fakes and need keys only when switched on", () => {
    const env = parseEnv(workerEnvSchema, validServerEnv, "worker");
    expect(env).toMatchObject({ PLANNER_PROVIDER: "fake", IMAGE_PROVIDER: "fake", AI_JOB_TIMEOUT_MS: 180_000 });
    const error = captureError(() => parseEnv(workerEnvSchema, { ...validServerEnv, PLANNER_PROVIDER: "gemini", IMAGE_PROVIDER: "cloudflare" }, "worker"));
    expect(error).toBeInstanceOf(EnvValidationError);
    if (error instanceof EnvValidationError) {
      expect([...error.invalidKeys].sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GEMINI_API_KEY"]);
    }
    expect(
      parseEnv(
        workerEnvSchema,
        {
          ...validServerEnv,
          PLANNER_PROVIDER: "gemini",
          GEMINI_API_KEY: "test-gemini-key-0123456789",
          IMAGE_PROVIDER: "cloudflare",
          CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          CLOUDFLARE_API_TOKEN: "test-cloudflare-token-0123",
        },
        "worker",
      ).PLANNER_PROVIDER,
    ).toBe("gemini");
  });

  it("the local try-on defaults to the few-step sampler, and the earlier settings can be asked for", () => {
    expect(parseEnv(workerEnvSchema, validServerEnv, "worker")).toMatchObject({ LOCAL_TRYON_SAMPLER: "lcm", LOCAL_TRYON_STEPS: 8, LOCAL_TRYON_GUIDED: 1 });
    expect(parseEnv(workerEnvSchema, { ...validServerEnv, LOCAL_TRYON_SAMPLER: "unipc", LOCAL_TRYON_STEPS: "20", LOCAL_TRYON_GUIDED: "0.6" }, "worker")).toMatchObject({ LOCAL_TRYON_SAMPLER: "unipc", LOCAL_TRYON_GUIDED: 0.6 });
    const earlier = { ...validServerEnv, LOCAL_TRYON_SAMPLER: "ddim", LOCAL_TRYON_STEPS: "30", LOCAL_TRYON_GUIDED: "1" };
    expect(parseEnv(workerEnvSchema, earlier, "worker")).toMatchObject({ LOCAL_TRYON_SAMPLER: "ddim", LOCAL_TRYON_STEPS: 30, LOCAL_TRYON_GUIDED: 1 });
    expect(() => parseEnv(workerEnvSchema, { ...validServerEnv, LOCAL_TRYON_SAMPLER: "euler" }, "worker")).toThrow(/LOCAL_TRYON_SAMPLER/);
    expect(() => parseEnv(workerEnvSchema, { ...validServerEnv, LOCAL_TRYON_GUIDED: "0" }, "worker")).toThrow(/LOCAL_TRYON_GUIDED/);
  });

  it("the app's server env never holds AI provider keys", () => {
    for (const key of Object.keys(serverEnvSchema.shape)) {
      expect(key).not.toMatch(/GEMINI|CLOUDFLARE/);
    }
  });
});
