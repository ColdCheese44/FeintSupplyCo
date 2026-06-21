import "dotenv/config";

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  getDesignById,
  getListingById,
  getPodProductByListingId,
  initializeDatabase,
  markListingPaused,
  markListingPublished,
  pausePublishing,
  resolveProjectPath,
  updateDesignAssets,
  updateListingPrintifyProductId,
  upsertPodProduct,
} from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import {
  PRINTFUL_BLUEPRINT_IDS,
  createPrintfulProduct,
  getCatalogProductVariants,
  resolvePrintfulCatalogForProductType,
  searchCatalogProducts,
  supportsPrintfulSync,
  uploadFile as uploadPrintfulFile,
} from "../lib/printful-client.js";
import { createPrintifyProduct, getPrintifyProduct, publishPrintifyProduct, uploadPrintifyImage } from "../lib/printify-client.js";
import { PRODUCT_BASE_PRICES, normalizeProductType, type ProductType } from "../lib/product-types.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface PodPublishResult {
  success: boolean;
  printifyProductId?: string;
  printfulProductId?: string;
  etsyListingId?: string;
  listingUrl?: string;
  warning?: string;
  error?: string;
}

interface PrintifyCatalogEntry {
  productType: string;
  blueprintId: number;
  title: string;
  defaultPrintProviderId: number;
  variantIds: number[];
  defaultBaseCost: number;
}

interface PrintfulCatalogEntry {
  productType: string;
  storeProductName: string;
  variantIds?: number[];
  defaultBaseCost: number;
}

interface UploadStepResult {
  provider: "printful" | "printify";
  printfulFileId?: number;
  printfulFileUrl?: string;
  printifyImageId?: string;
}

const logger = createLogger("pod-publisher");

/**
 * Parses JSON metadata defensively so manual-review safety rails can be enforced even on older records.
 */
function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Loads the product catalog entry for a Printify-backed product type.
 */
async function loadPrintifyCatalog(productType: string): Promise<PrintifyCatalogEntry | null> {
  const catalogPath = resolveProjectPath("data/product_catalog/printify-blueprints.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as PrintifyCatalogEntry[];
  return catalog.find((item) => item.productType === productType) ?? null;
}

/**
 * Loads the optional Printful backup catalog entry for a product type.
 */
async function loadPrintfulCatalog(productType: string): Promise<PrintfulCatalogEntry | null> {
  const catalogPath = resolveProjectPath("data/product_catalog/printful-products.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as PrintfulCatalogEntry[];
  return catalog.find((item) => item.productType === productType) ?? null;
}

/**
 * Resolves the upstream Printful catalog product ID for a product type by matching one of the configured variant IDs.
 */
async function resolvePrintfulBlueprintId(productType: string, variantIds: number[]): Promise<number | null> {
  const hardcodedBlueprintId = PRINTFUL_BLUEPRINT_IDS[productType as keyof typeof PRINTFUL_BLUEPRINT_IDS];
  if (typeof hardcodedBlueprintId === "number") {
    return hardcodedBlueprintId;
  }

  const searchTerm = productType === "t-shirt"
    ? "unisex t-shirt"
    : productType === "hoodie"
      ? "unisex hoodie"
      : productType;
  const payload = await searchCatalogProducts(searchTerm);

  for (const product of payload.data ?? []) {
    const variants = await getCatalogProductVariants(product.id);
    if (variants.some((variant) => variantIds.includes(variant.id))) {
      return product.id;
    }
  }

  logger.warn("Unable to resolve a Printful blueprint ID for POD metadata.", {
    productType,
    variantIds,
    searchTerm,
  });
  return null;
}

/**
 * Splits the stored listing tags into the flat string array expected by Printify.
 */
function parseTags(tags: string): string[] {
  return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
}

/**
 * Enforces the minimum profit margin safety rail before any product is pushed live.
 */
function assertHealthyMargin(baseCost: number, retailPrice: number): number {
  const profitMargin = (retailPrice - baseCost) / retailPrice;
  if (profitMargin < 0.15) {
    pausePublishing(`Profit margin fell below 15%. Base ${baseCost.toFixed(2)}, retail ${retailPrice.toFixed(2)}.`);
    throw new Error(`Publishing paused because projected profit margin is only ${(profitMargin * 100).toFixed(2)}%.`);
  }
  return Number(profitMargin.toFixed(4));
}

/**
 * Creates an optional backup Printful sync product when the provider token and remote asset URL are available.
 */
async function createOptionalPrintfulBackup(
  productType: ProductType,
  remoteAssetUrl: string | undefined,
  retailPrice: number,
): Promise<{ productId?: string; metadata?: Record<string, unknown> }> {
  if (!process.env.PRINTFUL_API_TOKEN?.trim() || !remoteAssetUrl || !supportsPrintfulSync(productType)) {
    return {};
  }

  const catalogEntry = await loadPrintfulCatalog(productType);
  if (!catalogEntry) {
    return {};
  }
  const resolvedCatalog = await resolvePrintfulCatalogForProductType(productType);
  const fileType = productType === "t-shirt" || productType === "hoodie" ? "front" : "default";

  const result = await createPrintfulProduct({
    syncProduct: {
      name: catalogEntry.storeProductName,
      thumbnail: remoteAssetUrl,
    },
    syncVariants: resolvedCatalog.variants.map((variant) => ({
      variant_id: variant.id,
      retail_price: retailPrice.toFixed(2),
      files: [{ type: fileType, url: remoteAssetUrl }],
    })),
  });

  return {
    productId: String(result.sync_product?.id ?? result.id),
    metadata: {
      printfulVariantId: resolvedCatalog.variants[0]?.id ?? null,
      remoteAssetUrl,
    },
  };
}

/**
 * Uploads the design asset to Printful first, then falls back to Printify only if Printful fails.
 */
async function uploadDesignAsset(localImagePath: string): Promise<UploadStepResult> {
  const fileName = basename(localImagePath);

  try {
    const uploadedFile = await uploadPrintfulFile(localImagePath, fileName);
    logger.action("POD image upload completed", "success", {
      provider: "printful",
      fileId: uploadedFile.id,
      url: uploadedFile.url,
      localImagePath,
    });
    return {
      provider: "printful",
      printfulFileId: uploadedFile.id,
      printfulFileUrl: uploadedFile.url,
    };
  } catch (printfulError) {
    logger.warn("Printful upload failed; falling back to Printify image upload", {
      localImagePath,
      error: printfulError instanceof Error ? printfulError.message : String(printfulError),
    });
  }

  const printifyImageId = await uploadPrintifyImage(localImagePath, fileName);
  logger.action("POD image upload completed", "success", {
    provider: "printify",
    imageId: printifyImageId,
    localImagePath,
  });
  return {
    provider: "printify",
    printifyImageId,
  };
}

/**
 * Pushes a generated design to Printify, links it to the local listing record, and optionally prepares a Printful backup.
 */
export async function publishPodProduct(listingId: number): Promise<PodPublishResult> {
  if (isDryRunEnabled()) {
    const result: PodPublishResult = {
      success: true,
      printifyProductId: `dry-run-printify-${listingId}`,
      printfulProductId: process.env.PRINTFUL_API_TOKEN?.trim() ? `dry-run-printful-${listingId}` : undefined,
      etsyListingId: `dry-run-etsy-${listingId}`,
      listingUrl: `https://www.etsy.com/listing/dry-run-etsy-${listingId}`,
      warning: "Dry-run only. No POD provider or Etsy publish request was made.",
    };
    logger.action("Dry-run POD publish completed", "skip", { listingId, result });
    return result;
  }

  initializeDatabase();
  const listing = getListingById(listingId);
  if (!listing) {
    throw new Error(`Listing ${listingId} was not found in the local database.`);
  }

  const existingPodProduct = getPodProductByListingId(listingId);
  if (existingPodProduct?.provider === "printful" && existingPodProduct.printful_product_id) {
    logger.action("Reusing existing Printful POD product", "success", {
      listingId,
      printfulProductId: existingPodProduct.printful_product_id,
      status: existingPodProduct.status,
    });
    return {
      success: true,
      printfulProductId: existingPodProduct.printful_product_id,
      warning: "Reusing existing Printful product mapping. Etsy listing publication continues in the separate Etsy publish step.",
    };
  }

  const designId = listing.design_id;
  if (!designId) {
    throw new Error(`Listing ${listingId} does not reference a generated design yet.`);
  }

  const design = getDesignById(designId);
  if (!design || !design.image_path) {
    throw new Error(`Design ${designId} is missing or does not have a local image path for Printify upload.`);
  }

  const listingMetadata = parseMetadata(listing.metadata);
  const designMetadata = parseMetadata(design.metadata);
  const requiresManualReview =
    listingMetadata.requiresManualReview === true
    || listingMetadata.requires_manual_review === true
    || designMetadata.requiresManualReview === true
    || designMetadata.requires_manual_review === true;
  const manualReviewReason = [
    listingMetadata.manualReviewReason,
    listingMetadata.manual_review_reason,
    designMetadata.manualReviewReason,
    designMetadata.manual_review_reason,
  ].find((value) => typeof value === "string" && value.length > 0) as string | undefined;

  if (requiresManualReview) {
    markListingPaused(listing.id, {
      ...listingMetadata,
      requiresManualReview: true,
      manualReviewReason: manualReviewReason ?? "Manual review is required before POD publishing.",
      publishBlocked: true,
    });
    throw new Error(manualReviewReason ?? "Listing is flagged for manual review and cannot be auto-published.");
  }

  const productType = normalizeProductType(listing.product_type ?? design.product_type);
  if (!productType) {
    throw new Error(`Listing ${listingId} uses an unsupported product type "${listing.product_type ?? design.product_type}".`);
  }

  if (productType === "enamel-pin") {
    markListingPaused(listing.id, {
      ...listingMetadata,
      manualFulfillmentOnly: true,
      requiresApproval: true,
      manualReviewReason: "Enamel pins use the Etsy-only made-to-order flow.",
      publishBlocked: true,
    });
    return {
      success: false,
      error: "Enamel pins are not published through POD. Use the Etsy-only approval flow with a digital mockup.",
    };
  }

  const printifyCatalog = await loadPrintifyCatalog(productType);
  const printfulCatalog = await loadPrintfulCatalog(productType);
  const defaultBaseCost = printifyCatalog?.defaultBaseCost ?? printfulCatalog?.defaultBaseCost;
  if (defaultBaseCost == null) {
    throw new Error(`No product catalog entry exists for product type "${productType}".`);
  }

  const retailPrice = PRODUCT_BASE_PRICES[productType];
  const profitMargin = assertHealthyMargin(defaultBaseCost, retailPrice);

  logger.action("Publishing POD product", "start", { listingId, designId, productType, retailPrice, profitMargin });

  try {
    const uploadResult = await uploadDesignAsset(design.image_path);
    updateDesignAssets(design.id, {
      metadata: {
        ...designMetadata,
        podUploadProvider: uploadResult.provider,
        printfulFileId: uploadResult.printfulFileId ?? null,
        printfulFileUrl: uploadResult.printfulFileUrl ?? null,
        printifyImageId: uploadResult.printifyImageId ?? null,
      },
    });

    if (uploadResult.provider === "printful" && uploadResult.printfulFileUrl) {
      if (!printfulCatalog) {
        throw new Error(`No Printful catalog entry exists for product type "${productType}".`);
      }
      const resolvedPrintfulCatalog = await resolvePrintfulCatalogForProductType(productType);
      const printfulBlueprintId =
        PRINTFUL_BLUEPRINT_IDS[productType]
        ?? await resolvePrintfulBlueprintId(productType, resolvedPrintfulCatalog.variants.map((variant) => variant.id));
      const fileType = productType === "t-shirt" || productType === "hoodie" ? "front" : "default";

      const printfulProduct = await createPrintfulProduct({
        syncProduct: {
          name: printfulCatalog.storeProductName,
          thumbnail: uploadResult.printfulFileUrl,
        },
        syncVariants: resolvedPrintfulCatalog.variants.map((variant) => ({
          variant_id: variant.id,
          retail_price: retailPrice.toFixed(2),
          files: [{ type: fileType, url: uploadResult.printfulFileUrl as string }],
        })),
      });

      upsertPodProduct({
        listingId: listing.id,
        printfulProductId: String(printfulProduct.sync_product?.id ?? printfulProduct.id),
        blueprintId: printfulBlueprintId,
        baseCost: printfulCatalog.defaultBaseCost,
        retailPrice,
        profitMargin,
        status: "published",
        provider: "printful",
        variantId: String(resolvedPrintfulCatalog.variants[0]?.id ?? ""),
        metadata: {
          uploadedImagePath: design.image_path,
          uploadProvider: "printful",
          printfulFileId: uploadResult.printfulFileId ?? null,
          printfulFileUrl: uploadResult.printfulFileUrl,
          blueprintId: printfulBlueprintId,
          variantIds: resolvedPrintfulCatalog.variants.map((variant) => variant.id),
        },
      });

      const result: PodPublishResult = {
        success: true,
        printfulProductId: String(printfulProduct.sync_product?.id ?? printfulProduct.id),
        warning: "Printful handled the design upload and product creation. Etsy listing publication continues in the separate Etsy publish step.",
      };
      logger.action("Published POD product", "success", result);
      return result;
    }

    const uploadedImageId = uploadResult.printifyImageId;
    if (!uploadedImageId) {
      throw new Error("POD upload completed without a usable Printify image ID or Printful file URL.");
    }
    if (!printifyCatalog) {
      throw new Error(`Printify fallback is not configured for product type "${productType}".`);
    }

    const product = await createPrintifyProduct({
      title: listing.title,
      description: listing.description,
      blueprintId: printifyCatalog.blueprintId,
      printProviderId: printifyCatalog.defaultPrintProviderId,
      variants: printifyCatalog.variantIds.map((variantId) => ({
        id: variantId,
        price: Math.round(retailPrice * 100),
        is_enabled: true,
      })),
      imageId: uploadedImageId,
      tags: parseTags(listing.tags),
    });

    await publishPrintifyProduct(product.id);
    const syncedProduct = await getPrintifyProduct(product.id);
    const printfulBackup = await createOptionalPrintfulBackup(productType, undefined, retailPrice);

    updateListingPrintifyProductId(listing.id, product.id);
    const etsyListingId = syncedProduct.external?.id ? String(syncedProduct.external.id) : undefined;
    if (etsyListingId) {
      markListingPublished(listing.id, etsyListingId);
    } else {
      markListingPaused(listing.id, {
        warning: "Waiting for Etsy external listing ID from Printify sync.",
        printifyProductId: product.id,
      });
    }

    upsertPodProduct({
      listingId: listing.id,
      printifyProductId: product.id,
      printfulProductId: printfulBackup.productId ?? null,
      blueprintId: printifyCatalog.blueprintId,
      baseCost: printifyCatalog.defaultBaseCost,
      retailPrice,
      profitMargin,
      status: etsyListingId ? "published" : "etsy_sync_pending",
      provider: "printify",
      variantId: String(printifyCatalog.variantIds[0]),
      metadata: {
        uploadedImagePath: design.image_path,
        uploadProvider: uploadResult.provider,
        printfulFileId: uploadResult.printfulFileId ?? null,
        printfulFileUrl: uploadResult.printfulFileUrl ?? null,
        printifyImageId: uploadedImageId,
        printfulBackup: printfulBackup.metadata ?? null,
      },
    });

    const result: PodPublishResult = {
      success: true,
      printifyProductId: product.id,
      printfulProductId: printfulBackup.productId,
      etsyListingId,
      listingUrl: etsyListingId ? `https://www.etsy.com/listing/${etsyListingId}` : undefined,
      warning: etsyListingId ? undefined : "Printify published the product, but Etsy sync has not exposed an external listing ID yet.",
    };
    logger.action("Published POD product", "success", result);
    return result;
  } catch (error) {
    const existingMapping = getPodProductByListingId(listing.id);
    if (!existingMapping) {
      upsertPodProduct({
        listingId: listing.id,
        baseCost: defaultBaseCost,
        retailPrice,
        profitMargin,
        status: "failed",
        provider: printifyCatalog ? "printify" : "printful",
        variantId: printifyCatalog ? String(printifyCatalog.variantIds[0]) : null,
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    logger.error("POD product publish failed", error, { listingId });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reads CLI flags for standalone POD publishing.
 */
function parseCliArgs(argv: string[]): { listingId: number } {
  const listingIdIndex = argv.findIndex((argument) => argument === "--listing-id");
  const listingId = listingIdIndex >= 0 ? Number.parseInt(argv[listingIdIndex + 1] ?? "", 10) : Number.NaN;
  if (!Number.isFinite(listingId)) {
    throw new Error("Missing required --listing-id argument for POD publishing.");
  }
  return { listingId };
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone POD publisher entry point and prints the publish result as JSON.
 */
async function main(): Promise<void> {
  try {
    const { listingId } = parseCliArgs(process.argv.slice(2));
    const result = await publishPodProduct(listingId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error("Standalone pod-publisher execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
