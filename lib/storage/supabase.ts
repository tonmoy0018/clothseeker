import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import type { StorageAdapter } from "./adapter";
import { SupabaseStorageAdapter } from "./supabase-core";

let instance: SupabaseStorageAdapter | undefined;

/** The app's storage adapter (secret key, server only). */
export function getStorage(): StorageAdapter {
  instance ??= new SupabaseStorageAdapter(createSupabaseAdminClient);
  return instance;
}
