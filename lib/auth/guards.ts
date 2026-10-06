import "server-only";

import { notFound, redirect } from "next/navigation";

import { safeNextPath } from "./safe-next";
import { getCurrentUser, type CurrentUser } from "./session";

/** Pages/actions that need a signed-in user. Redirects to /login and returns afterwards. */
export async function requireUser(nextPath: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(safeNextPath(nextPath))}`);
  }
  return user;
}

/** Admin-only pages and actions. Non-admins get a 404 so the admin area is not advertised. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    notFound();
  }
  return user;
}
