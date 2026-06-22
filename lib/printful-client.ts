import "dotenv/config";

import { uploadToImgbb } from "./imgbb-client.js";
import { createLogger } from "./logger.js";
import { normalizeProductType, type ProductType } from "./product-types.js";

export interface PrintfulProductCreateInput {
  syncProduct: {
    name: string;
    thumbnail?: string;
    externalId?: string;
    is_ignored?: boolean;
  };
  syncVariants: Array<{
    variant_id?: number | null;
    retail_price: string;
    files: Array<{ url?: string; id?: number; type?: string }>;
  }>;
}

export interface PrintfulProductResult {
  id: number;
  sync_product?: {
    id: number;
    name: string;
    external_id?: string | null;
  };
  sync_variants?: Array<{
    id?: number;
    external_id?: string | null;
    variant_id?: number | null;
  }>;
}

export interface PrintfulOrderCreateInput {
  externalId: string;
  recipient: {
    name: string;
    address1: string;
    address2?: string;
    city: string;
    state_code?: string;
    country_code: string;
    zip: string;
    email?: string;
    phone?: string;
  };
  items: Array<{
    sync_variant_id: number;
    quantity: number;
  }>;
}

export interface PrintfulOrderResult {
  id: number;
  status?: string;
  tracking_number?: string;
  carrier?: string;
}

export interface PrintfulFileUploadResult {
  id: number;
  url: string;
  filename?: string;
  status?: string;
  preview_url?: string;
  thumbnail_url?: string;
}

export interface PrintfulCatalogProduct {
  id: number;
  name?: string;
  // Printful's v1 /products catalog uses these fields rather than `name`.
  title?: string;
  type_name?: string;
  model?: string;
  brand?: string;
  variants?: PrintfulCatalogVariant[];
}

/**
 * Returns a human-readable label for a Printful catalog product across v1/v2 response shapes.
 */
export function printfulProductLabel(product: PrintfulCatalogProduct): string {
  const brandModel = [product.brand, product.model].filter(Boolean).join(" ").trim();
  return product.name ?? product.title ?? (brandModel || product.type_name || "");
}

export interface PrintfulCatalogVariant {
  id: number;
  name: string;
  color?: string;
  color_code?: string;
  size?: string;
  // Printful v1 reports availability as an array of per-region {region, status}; older shapes used a string.
  availability_status?: string | Array<{ region?: string; status?: string }>;
}

export interface PrintfulMockupResult {
  mockupUrl: string;
  taskKey: string;
}

export interface PrintfulSyncVariantInfo {
  id: number;
  sync_product_id?: number;
  variant_id?: number;
  external_id?: string | null;
  name?: string;
  retail_price?: string;
}

export interface PrintfulListingSyncResult {
  syncProductId: string;
  syncVariantIds: number[];
  fileId: number;
  fileUrl: string;
  blueprintId: number;
  catalogVariantIds: number[];
  thumbnailUrl: string;
}

const logger = createLogger("printful-client");
const printfulApiBaseUrl = "https://api.printful.com";
const printfulBlueprintCache = new Map<string, { blueprintId: number; variants: PrintfulCatalogVariant[] }>();
export const PRINTFUL_BLUEPRINT_IDS = {
  sticker: 358,
  "t-shirt": 71,
  poster: 1,
  mug: 19,
  hoodie: 146,
  hat: 206, // Classic Dad Hat (Yupoong 6245CM)
  "enamel-pin": null,
} as const;

/**
 * Returns the configured Printful token and fails fast when it is missing.
 */
function getPrintfulToken(): string {
  const token = process.env.PRINTFUL_API_TOKEN?.trim();
  if (!token) {
    throw new Error("PRINTFUL_API_TOKEN is missing. Add it to the project .env file before using Printful.");
  }
  return token;
}

/**
 * Reads a response body into text so provider errors remain actionable in logs and retries.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `Unable to read Printful error body: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Performs an authenticated Printful API request with normalized headers.
 */
async function printfulRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getPrintfulToken()}`);
  headers.set("Accept", "application/json");

  return fetch(`${printfulApiBaseUrl}${path}`, {
    ...init,
    headers,
  });
}

/**
 * Finds a sticker-like catalog variant so sync product creation has a valid variant when one is available.
 */
async function findStickerVariantId(): Promise<number | null> {
  const payload = await searchCatalogProducts("sticker");

  for (const product of payload.data ?? []) {
    for (const variant of product.variants ?? []) {
      if (typeof variant.id === "number") {
        return variant.id;
      }
    }
  }

  logger.warn("No sticker-like Printful catalog variant was found during sync product creation.");
  return null;
}

/**
 * Filters apparel variants down to saleable black sizes so sync products stay focused and easy to fulfill.
 */
function filterBlackApparelVariants(variants: PrintfulCatalogVariant[]): PrintfulCatalogVariant[] {
  const wantedSizes = new Set(["s", "m", "l", "xl", "2xl"]);
  return variants.filter((variant) => {
    const name = variant.name?.toLowerCase() ?? "";
    const color = variant.color?.toLowerCase() ?? "";
    const colorCode = variant.color_code?.toLowerCase() ?? "";
    const size = (variant.size ?? "").toLowerCase();
    const isBlack = color.includes("black") || colorCode.includes("#000000") || colorCode.includes("000000") || name.includes("black");
    const isWantedSize = wantedSizes.has(size) || [...wantedSizes].some((wanted) => name.includes(` ${wanted}`));
    return isBlack && isWantedSize;
  });
}

/**
 * Queries the Printful catalog with a free-text search so collection scripts can reuse one product blueprint across multiple listings.
 */
export async function searchCatalogProducts(search: string): Promise<{ data?: PrintfulCatalogProduct[] }> {
  const response = await printfulRequest("/products", {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Printful catalog lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as {
    result?: PrintfulCatalogProduct[];
    data?: PrintfulCatalogProduct[];
  };
  const products = payload.result ?? payload.data ?? [];
  const normalizedSearch = search.trim().toLowerCase();

  return {
    data: products.filter((product) => printfulProductLabel(product).toLowerCase().includes(normalizedSearch)),
  };
}

/**
 * Loads all variants for a single Printful catalog product so scripts can filter by size and color before creating sync products.
 */
export async function getCatalogProductVariants(productId: number | string): Promise<PrintfulCatalogVariant[]> {
  const response = await printfulRequest(`/products/${productId}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Printful variant lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as {
    result?: {
      variants?: PrintfulCatalogVariant[];
    };
  };
  const variants = payload.result?.variants ?? [];

  return variants.filter((variant) => isVariantOrderable(variant.availability_status));
}

/**
 * Returns whether a Printful catalog variant is orderable.
 *
 * Printful v1 reports availability as an array of per-region `{region, status}` where status is
 * `in_stock` / `stocked_on_demand` / `discontinued` / `out_of_stock`. A variant is orderable when at
 * least one region is in_stock or stocked_on_demand. Legacy string statuses and missing data are
 * handled conservatively so a shape change can never silently drop the entire catalog again.
 */
function isVariantOrderable(status: PrintfulCatalogVariant["availability_status"]): boolean {
  const orderable = new Set(["in_stock", "stocked_on_demand", "active"]);
  if (Array.isArray(status)) {
    return status.some((entry) => orderable.has(`${entry?.status ?? ""}`.toLowerCase()));
  }
  const value = `${status ?? ""}`.toLowerCase();
  if (!value) {
    return true; // No availability info: let order placement validate rather than dropping everything.
  }
  return orderable.has(value) || value.includes("active") || value.includes("in_stock");
}

/**
 * Returns whether Printful can create a sync product for the requested product type.
 */
export function supportsPrintfulSync(productType: string): boolean {
  const normalizedType = normalizeProductType(productType);
  return normalizedType !== null && PRINTFUL_BLUEPRINT_IDS[normalizedType] !== null;
}

/**
 * Chooses the right Printful catalog product and saleable variants for one local product type, caching the result for the server session.
 */
async function resolveBlueprintForProductType(productType: string): Promise<{ blueprintId: number; variants: PrintfulCatalogVariant[] }> {
  const normalizedType = normalizeProductType(productType);
  if (!normalizedType) {
    throw new Error(`Printful sync product creation is not configured for product type "${productType}".`);
  }
  const cached = printfulBlueprintCache.get(normalizedType);
  if (cached) {
    return cached;
  }

  try {
    if (normalizedType === "t-shirt" || normalizedType === "hoodie") {
      const payload = await searchCatalogProducts(normalizedType === "hoodie" ? "unisex hoodie" : "unisex t-shirt");
      const product = (payload.data ?? []).find((entry) => {
        const name = printfulProductLabel(entry).toLowerCase();
        return normalizedType === "hoodie"
          ? name.includes("hoodie")
          : name.includes("bella") || name.includes("gildan") || name.includes("unisex");
      });

      if (product) {
        const variants = await getCatalogProductVariants(product.id);
        const filteredVariants = filterBlackApparelVariants(variants);

        if (filteredVariants.length > 0) {
          const resolved = { blueprintId: product.id, variants: filteredVariants };
          printfulBlueprintCache.set(normalizedType, resolved);
          return resolved;
        }
      }
    }

    if (normalizedType === "sticker") {
      const payload = await searchCatalogProducts("kiss cut sticker");
      const product = (payload.data ?? []).find((entry) => {
        const name = printfulProductLabel(entry).toLowerCase();
        return name.includes("kiss") || name.includes("die cut") || name.includes("sticker");
      }) ?? (payload.data ?? [])[0];

      if (product) {
        const variants = await getCatalogProductVariants(product.id);
        if (variants.length > 0) {
          const resolved = { blueprintId: product.id, variants: [variants[0]] };
          printfulBlueprintCache.set(normalizedType, resolved);
          return resolved;
        }
      }
    }
  } catch (error) {
    logger.warn("Printful catalog lookup failed; falling back to a hardcoded blueprint ID.", {
      productType: normalizedType,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fallbackBlueprintId = PRINTFUL_BLUEPRINT_IDS[normalizedType as keyof typeof PRINTFUL_BLUEPRINT_IDS];
  if (fallbackBlueprintId === null) {
    throw new Error(`Printful does not offer POD sync support for product type "${normalizedType}". Use the Etsy-only flow instead.`);
  }

  if (fallbackBlueprintId) {
    logger.warn(`Using hardcoded blueprint ID for ${normalizedType}`, {
      productType: normalizedType,
      blueprintId: fallbackBlueprintId,
    });
    const variants = await getCatalogProductVariants(fallbackBlueprintId);
    let resolvedVariants: PrintfulCatalogVariant[];
    if (normalizedType === "t-shirt" || normalizedType === "hoodie") {
      resolvedVariants = filterBlackApparelVariants(variants);
    } else if (normalizedType === "hat") {
      // Hats are one-size; prefer the black colorway, else the first orderable variant.
      const black = variants.find((variant) =>
        `${variant.color ?? ""} ${variant.name ?? ""}`.toLowerCase().includes("black"));
      resolvedVariants = black ? [black] : variants.length > 0 ? [variants[0]] : [];
    } else {
      resolvedVariants = variants.length > 0 ? [variants[0]] : [];
    }

    if (resolvedVariants.length === 0) {
      throw new Error(`Hardcoded Printful blueprint ${fallbackBlueprintId} for ${normalizedType} did not return usable variants.`);
    }

    const resolved = { blueprintId: fallbackBlueprintId, variants: resolvedVariants };
    printfulBlueprintCache.set(normalizedType, resolved);
    return resolved;
  }

  throw new Error(`Printful sync product creation is not configured for product type "${productType}".`);
}

/**
 * Exposes the normalized Printful catalog resolution so collection scripts and POD publishing can share one product lookup path.
 */
export async function resolvePrintfulCatalogForProductType(productType: ProductType | string): Promise<{
  productType: ProductType | null;
  blueprintId: number;
  variants: PrintfulCatalogVariant[];
}> {
  const normalizedType = normalizeProductType(productType);
  if (!normalizedType) {
    throw new Error(`Printful catalog resolution is not configured for product type "${productType}".`);
  }

  const resolved = await resolveBlueprintForProductType(normalizedType);
  return {
    productType: normalizedType,
    blueprintId: resolved.blueprintId,
    variants: resolved.variants,
  };
}

/**
 * Uploads a local PNG file to Printful by first hosting it on imgbb, then passing the public HTTPS URL to Printful.
 */
export async function uploadFile(localImagePath: string, fileName: string): Promise<PrintfulFileUploadResult> {
  const publicUrl = await uploadToImgbb(localImagePath);
  console.log("Using URL:", publicUrl);
  const payload = {
    type: "default",
    url: publicUrl,
    filename: fileName,
  };

  logger.action("Uploading file to Printful library", "start", {
    localImagePath,
    fileName,
    requestPath: "/files",
    payloadKeys: Object.keys(payload),
    publicUrl,
  });

  console.log("Posting to Printful...");
  const response = await printfulRequest("/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const parsed = (await response.json()) as { result?: PrintfulFileUploadResult };
  if (!response.ok) {
    throw new Error(`Printful upload failed: ${response.status} - ${JSON.stringify(parsed)}`);
  }

  logger.action("Uploaded file to Printful library", "success", {
    fileId: parsed.result?.id,
    status: parsed.result?.status,
    url: parsed.result?.url,
  });
  if (!parsed.result) {
    throw new Error("Printful upload succeeded without a result payload.");
  }
  return parsed.result;
}

/**
 * Generates one Printful mockup image and returns the hosted mockup URL once the async task completes.
 */
export async function generateMockup(
  blueprintId: number,
  variantId: number,
  printfulFileId: number,
): Promise<string> {
  logger.action("Generating Printful mockup", "start", {
    blueprintId,
    variantId,
    printfulFileId,
  });

  const taskResponse = await printfulRequest("/v2/mockup-tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: blueprintId,
      variant_ids: [variantId],
      files: [
        {
          placement: "front",
          image_id: printfulFileId,
          position: {
            area_width: 1800,
            area_height: 2400,
            width: 1800,
            height: 2400,
            top: 0,
            left: 0,
          },
        },
      ],
      format: "jpg",
    }),
  });

  const taskPayload = (await taskResponse.json()) as {
    result?: { task_key?: string };
  };

  if (!taskResponse.ok) {
    throw new Error(`Mockup task failed: ${JSON.stringify(taskPayload)}`);
  }

  const taskKey = taskPayload.result?.task_key;
  if (!taskKey) {
    throw new Error("No task_key returned");
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));

    const pollResponse = await printfulRequest(`/v2/mockup-tasks/${taskKey}`, {
      method: "GET",
    });
    const pollPayload = (await pollResponse.json()) as {
      result?: {
        status?: string;
        mockups?: Array<{ mockup_url?: string }>;
      };
    };

    if (!pollResponse.ok) {
      throw new Error(`Mockup polling failed: ${JSON.stringify(pollPayload)}`);
    }

    const status = pollPayload.result?.status;
    if (status === "completed") {
      const mockupUrl = pollPayload.result?.mockups?.[0]?.mockup_url;
      if (mockupUrl) {
        logger.action("Generated Printful mockup", "success", {
          blueprintId,
          variantId,
          printfulFileId,
          taskKey,
          mockupUrl,
        });
        return mockupUrl;
      }

      throw new Error("Mockup completed but no URL returned");
    }

    if (status === "failed") {
      throw new Error(`Mockup generation failed: ${JSON.stringify(pollPayload)}`);
    }
  }

  throw new Error("Mockup generation timed out after 30s");
}

/**
 * Creates a backup Printful sync product so FeintSupplyCo has a second fulfillment path if Printify fails.
 */
export async function createPrintfulProduct(input: PrintfulProductCreateInput): Promise<PrintfulProductResult> {
  try {
    logger.action("Creating Printful sync product", "start", { name: input.syncProduct.name });
    const normalizedVariants = await Promise.all(input.syncVariants.map(async (variant) => {
      const resolvedVariantId = variant.variant_id ?? await findStickerVariantId();
      if (!resolvedVariantId) {
        logger.warn("Creating Printful sync product without a resolved sticker variant ID.", {
          name: input.syncProduct.name,
        });
      }

      return {
        retail_price: variant.retail_price,
        ...(resolvedVariantId ? { variant_id: resolvedVariantId } : {}),
        files: variant.files.map((file) => ({
          type: file.type ?? "default",
          ...(typeof file.id === "number" ? { id: file.id } : {}),
        })),
      };
    }));

    const response = await printfulRequest("/v2/sync/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sync_product: {
          name: input.syncProduct.name,
          ...(input.syncProduct.thumbnail ? { thumbnail: input.syncProduct.thumbnail } : {}),
          ...(input.syncProduct.externalId ? { external_id: input.syncProduct.externalId } : {}),
          ...(typeof input.syncProduct.is_ignored === "boolean" ? { is_ignored: input.syncProduct.is_ignored } : {}),
        },
        sync_variants: normalizedVariants,
      }),
    });

    if (!response.ok) {
      throw new Error(`Printful sync product creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as { result: PrintfulProductResult };
    logger.action("Created Printful sync product", "success", { productId: payload.result.id });
    return payload.result;
  } catch (error) {
    logger.error("Printful sync product creation failed", error, { name: input.syncProduct.name });
    throw new Error(`Printful sync product creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Loads sync variants for an existing Printful sync product so order routing can match size and color selections.
 */
export async function getSyncProductVariants(syncProductId: string | number): Promise<PrintfulSyncVariantInfo[]> {
  const response = await printfulRequest(`/v2/sync/products/${syncProductId}/variants`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Printful sync variant lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as {
    data?: PrintfulSyncVariantInfo[];
    result?: PrintfulSyncVariantInfo[];
  };

  return payload.data ?? payload.result ?? [];
}

/**
 * Creates a Printful sync product linked to one Etsy listing so incoming marketplace orders can route automatically.
 */
export async function createLinkedPrintfulSyncProduct(input: {
  title: string;
  productType: string;
  localImagePath: string;
  externalId: string;
  retailPrice: number;
}): Promise<PrintfulListingSyncResult> {
  const { blueprintId, variants } = await resolveBlueprintForProductType(input.productType);
  const uploadedFile = await uploadFile(input.localImagePath, input.localImagePath.split(/[\\/]/).pop() ?? "design.png");
  const thumbnailUrl = await uploadToImgbb(input.localImagePath);
  const normalizedProductType = normalizeProductType(input.productType);
  const fileType = normalizedProductType === "t-shirt" || normalizedProductType === "hoodie" ? "front" : "default";

  const product = await createPrintfulProduct({
    syncProduct: {
      name: input.title,
      thumbnail: thumbnailUrl,
      externalId: input.externalId,
    },
    syncVariants: variants.map((variant, index) => ({
      variant_id: variant.id,
      retail_price: input.retailPrice.toFixed(2),
      files: [{ type: fileType, id: uploadedFile.id }],
    })),
  });

  const resolvedSyncVariantIds = (product.sync_variants ?? [])
    .map((variant) => variant.id)
    .filter((variantId): variantId is number => typeof variantId === "number");

  return {
    syncProductId: String(product.sync_product?.id ?? product.id),
    syncVariantIds: resolvedSyncVariantIds,
    fileId: uploadedFile.id,
    fileUrl: uploadedFile.url,
    blueprintId,
    catalogVariantIds: variants.map((variant) => variant.id),
    thumbnailUrl,
  };
}

/**
 * Creates a backup Printful order so failed Printify orders still have a fulfillment path.
 */
export async function createPrintfulOrder(input: PrintfulOrderCreateInput): Promise<PrintfulOrderResult> {
  try {
    logger.action("Creating Printful order", "start", { externalId: input.externalId });
    const response = await printfulRequest("/v3/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: input.externalId,
        recipient: input.recipient,
        items: input.items,
      }),
    });

    if (!response.ok) {
      throw new Error(`Printful order creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as { result?: PrintfulOrderResult; data?: PrintfulOrderResult };
    const result = payload.result ?? payload.data;
    if (!result) {
      throw new Error("Printful order creation succeeded without a result payload.");
    }

    logger.action("Created Printful order", "success", { orderId: result.id });
    return result;
  } catch (error) {
    logger.error("Printful order creation failed", error, { externalId: input.externalId });
    throw new Error(`Printful order creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetches the current Printful order status so fallback fulfillment can still sync tracking downstream.
 */
export async function getPrintfulOrder(orderId: string | number): Promise<PrintfulOrderResult> {
  try {
    logger.action("Fetching Printful order status", "start", { orderId });
    const response = await printfulRequest(`/v3/orders/${orderId}`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Printful order lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as {
      result?: PrintfulOrderResult;
      data?: PrintfulOrderResult;
    };
    const result = payload.result ?? payload.data;
    if (!result) {
      throw new Error("Printful order lookup succeeded without a result payload.");
    }

    logger.action("Fetched Printful order status", "success", { orderId, status: result.status });
    return result;
  } catch (error) {
    logger.error("Printful order lookup failed", error, { orderId });
    throw new Error(`Printful order lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
