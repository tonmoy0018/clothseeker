import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth/session";

import { StartForms } from "../start/start-forms";

export const metadata: Metadata = { title: "Upload your dress — ClothSeeker" };

// "Upload your dress": a photo of any dress, shirt or panjabi becomes the customer's own, to make exactly
// as it is or customise (lib/own-dress), priced by the team. The same form as /design/start's photo part.
export default async function UploadDressPage() {
  const user = await getCurrentUser();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold sm:text-4xl">Upload your dress</h1>
        <p className="max-w-2xl text-muted-foreground">
          Got a photo of a dress, shirt or panjabi you love? We can make it exactly as it is, or you can customise it first: change its colours, add prints,
          text or embroidery, and try it on. Then we send you a price within 24 hours.
        </p>
      </div>
      <StartForms signedIn={user?.role === "CUSTOMER"} photoOnly path="/design/upload" />
    </div>
  );
}
