import type { Role } from "@/lib/generated/prisma/enums";

// Pure authorization rules. No I/O, so every rule is unit tested.
// ClothSeeker has exactly two roles: CUSTOMER and ADMIN (see CLAUDE.md → Roles).

export type Actor = {
  id: string;
  role: Role;
};

export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";

  constructor(message = "You do not have access to this resource") {
    super(message);
  }
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === "ADMIN";
}

export function isCustomer(actor: Actor): boolean {
  return actor.role === "CUSTOMER";
}

/** Customer-owned records (cart, designs, orders, ...) are only accessible to their owner. */
export function owns(actor: Actor, ownerId: string): boolean {
  return actor.id === ownerId;
}

export function assertOwns(actor: Actor, ownerId: string): void {
  if (!owns(actor, ownerId)) {
    throw new ForbiddenError();
  }
}

export function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor)) {
    throw new ForbiddenError("Admin access required");
  }
}

/** Shopping actions (cart, checkout) are for customers; admins manage the store instead. */
export function assertCustomer(actor: Actor): void {
  if (!isCustomer(actor)) {
    throw new ForbiddenError("Only customer accounts can shop");
  }
}
