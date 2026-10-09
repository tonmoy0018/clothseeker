import "server-only";

import { getServerEnv } from "@/lib/env/server";

import { MockCourier } from "./mock";

let courier: MockCourier | undefined;

/** The configured courier. Only the mock exists; real couriers implement CourierProvider. */
export function getCourier(name?: string): MockCourier {
  if (name !== undefined && name !== "mock") {
    throw new Error("Unknown courier");
  }
  courier ??= new MockCourier(getServerEnv().MOCK_COURIER_WEBHOOK_SECRET);
  return courier;
}
