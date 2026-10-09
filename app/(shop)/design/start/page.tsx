import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth/session";

import { StartForms } from "./start-forms";

export const metadata: Metadata = { title: "Start a design — ClothSeeker" };

export default async function StartDesignPage() {
  const user = await getCurrentUser();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Start a design</h1>
        <p className="text-muted-foreground">Show us a dress you love or describe it. We&apos;ll find the closest ClothSeeker dress to start from, ready for you to customize.</p>
      </div>
      <StartForms signedIn={user?.role === "CUSTOMER"} />
    </div>
  );
}
