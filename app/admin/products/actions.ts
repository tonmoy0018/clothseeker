"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { removeProductPhoto, setCoverPhoto, uploadProductPhoto } from "@/lib/admin/media";
import { createProduct, setProductStatus, updateProduct } from "@/lib/admin/products";
import { createTemplate } from "@/lib/admin/templates";
import { addVariant, updateVariant } from "@/lib/admin/variants";
import { requireAdmin } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/media/process-image";
import { getStorage } from "@/lib/storage/supabase";

import { field, fileBytes, toFormState, type FormState } from "../form-state";

// Thin wrappers: authorize, call the service, map errors, revalidate. Rules live in lib/admin.

function refresh(productId?: string): void {
  revalidatePath("/admin", "layout");
  revalidatePath("/", "layout");
  if (productId) {
    revalidatePath(`/admin/products/${productId}`);
  }
}

export async function createProductAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  let id: string;
  try {
    ({ id } = await createProduct(getPrisma(), admin, {
      name: field(formData, "name"),
      slug: field(formData, "slug"),
      categoryId: field(formData, "categoryId"),
      description: field(formData, "description"),
    }));
  } catch (error) {
    return toFormState(error);
  }
  refresh();
  redirect(`/admin/products/${id}`);
}

export async function updateProductAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const id = field(formData, "id");
  try {
    await updateProduct(getPrisma(), admin, {
      id,
      name: field(formData, "name"),
      slug: field(formData, "slug"),
      categoryId: field(formData, "categoryId"),
      description: field(formData, "description"),
    });
  } catch (error) {
    return toFormState(error);
  }
  refresh(id);
  return { ok: "Saved." };
}

export async function setProductStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const id = field(formData, "id");
  try {
    await setProductStatus(getPrisma(), admin, { id, status: field(formData, "status") });
  } catch (error) {
    return toFormState(error);
  }
  refresh(id);
  return { ok: "Status updated." };
}

export async function addVariantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const productId = field(formData, "productId");
  try {
    await addVariant(getPrisma(), admin, {
      productId,
      size: field(formData, "size"),
      colorName: field(formData, "colorName"),
      colorHex: field(formData, "colorHex"),
      priceTaka: field(formData, "priceTaka"),
      stock: field(formData, "stock"),
    });
  } catch (error) {
    return toFormState(error);
  }
  refresh(productId);
  return { ok: "Size/color added." };
}

export async function updateVariantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  try {
    await updateVariant(getPrisma(), admin, {
      variantId: field(formData, "variantId"),
      priceTaka: field(formData, "priceTaka"),
      stock: field(formData, "stock"),
      isActive: formData.get("isActive") === "on",
    });
  } catch (error) {
    return toFormState(error);
  }
  refresh(field(formData, "productId"));
  return { ok: "Saved." };
}

export async function uploadPhotoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const productId = field(formData, "productId");
  const bytes = await fileBytes(formData, "photo", MAX_UPLOAD_BYTES);
  if (!(bytes instanceof Uint8Array)) {
    return bytes;
  }
  try {
    await uploadProductPhoto(getPrisma(), getStorage(), admin, productId, bytes);
  } catch (error) {
    return toFormState(error);
  }
  refresh(productId);
  return { ok: "Photo uploaded." };
}

export async function removePhotoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const productId = field(formData, "productId");
  try {
    await removeProductPhoto(getPrisma(), getStorage(), admin, { productId, key: field(formData, "key") });
  } catch (error) {
    return toFormState(error);
  }
  refresh(productId);
  return {};
}

export async function setCoverPhotoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const productId = field(formData, "productId");
  try {
    await setCoverPhoto(getPrisma(), admin, { productId, key: field(formData, "key") });
  } catch (error) {
    return toFormState(error);
  }
  refresh(productId);
  return {};
}

export async function createTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const productId = field(formData, "productId");
  try {
    await createTemplate(getPrisma(), admin, productId);
  } catch (error) {
    return toFormState(error);
  }
  refresh(productId);
  redirect(`/admin/products/${productId}/template`);
}
