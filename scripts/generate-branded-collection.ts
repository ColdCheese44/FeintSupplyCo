import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  createDesignRecord,
  createDraftListing as createLocalDraftListing,
  getActiveNiches,
  getShopSections,
  initializeDatabase,
  resolveProjectPath,
  updateListingImagePath,
  updateListingStatus,
  upsertPodProduct,
  type ListingRecord,
  type NicheRecord,
  type PodProductRecord,
} from "../lib/db.js";
import { appendAiDisclosure } from "../lib/legal-filter.js";
import { createLogger } from "../lib/logger.js";
import {
  createPrintfulProduct,
  resolvePrintfulCatalogForProductType,
  uploadFile as uploadPrintfulFile,
} from "../lib/printful-client.js";
import { PRODUCT_BASE_PRICES, getProductDisplayName, type ProductType } from "../lib/product-types.js";
import { uploadToImgbb } from "../lib/imgbb-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { publishListing } from "../skills/etsy-publish.js";
import { validateTags } from "../skills/listing-gen.js";

export interface CollectionScriptOptions {
  dryRun: boolean;
}

export interface CollectionDesignSpec {
  id: number;
  name: string;
  concept: string;
  sectionTitle: string;
}

export interface CollectionRunItem {
  designId: number;
  name: string;
  listingId?: number;
  etsyListingId?: string;
  localDesignPath?: string;
  printfulProductId?: string;
  published: boolean;
  pendingApproval: boolean;
  errors: string[];
}

export interface CollectionRunResult {
  dryRun: boolean;
  generatedAt: string;
  publishedCount: number;
  pendingCount: number;
  items: CollectionRunItem[];
}

export interface DeterministicCollectionConfig<DesignRecord extends { id: number; outputPath: string }> {
  productType: ProductType;
  loggerName: string;
  rootDirectory: string;
  reportPath: string;
  preferredNicheNames: string[];
  defaultTags: string[];
  designs: CollectionDesignSpec[];
  generateDesign: (designId: number) => Promise<DesignRecord>;
}

const qualityScore = 0.96;

/**
 * Returns whether generated collection listings should pause for approval instead of publishing immediately.
 */
function requiresApproval(): boolean {
  return (process.env.REQUIRE_APPROVAL ?? "").trim().toLowerCase() === "true";
}

/**
 * Finds the best matching active niche for one deterministic collection.
 */
function resolveCollectionNiche(preferredNames: string[]): NicheRecord {
  const activeNiches = getActiveNiches();
  for (const preferredName of preferredNames) {
    const match = activeNiches.find((niche) => niche.name.toLowerCase() === preferredName.toLowerCase());
    if (match) {
      return match;
    }
  }

  if (activeNiches.length === 0) {
    throw new Error("No active niches were available for the deterministic branded collection.");
  }

  return activeNiches[0];
}

/**
 * Resolves a suggested Etsy section ID from the locally cached section list when one is available.
 */
function resolveSuggestedSectionId(sectionTitle: string): string | null {
  const section = getShopSections().find((entry) => entry.title.toLowerCase() === sectionTitle.toLowerCase());
  return section ? String(section.etsy_section_id) : null;
}

/**
 * Builds deterministic listing copy so preview runs remain stable and network-free.
 */
function buildListingCopy(config: DeterministicCollectionConfig<{ id: number; outputPath: string }>, spec: CollectionDesignSpec): {
  title: string;
  description: string;
  tags: string[];
} {
  const productLabel = getProductDisplayName(config.productType);
  const title = `Feint Supply Co. - ${spec.name} ${productLabel}`.slice(0, 140);
  const body = [
    `${spec.name} takes the Feint Supply Co. brand language and pushes it into a made-to-order ${productLabel} built around ${spec.concept.toLowerCase()}. The result stays quiet, sharp, and specific without drifting into novelty merch territory.`,
    `This piece is designed for customers who already recognize the overlap between service culture, cyber-adjacent restraint, and disciplined visual identity. The composition stays clean enough to live in a serious space while still carrying enough attitude to feel intentional.`,
    `Every order is made to order through our production partner, with standard production time of 3-5 business days before shipment. The artwork is AI-assisted, but the final direction, editing, and collection curation stay anchored to the Feint Supply Co. brand voice.`,
  ].join("\n\n");

  return {
    title,
    description: appendAiDisclosure(body),
    tags: validateTags(config.defaultTags),
  };
}

/**
 * Creates the local design and listing records used by approval and publish flows later in the pipeline.
 */
function createCollectionRecords(
  config: DeterministicCollectionConfig<{ id: number; outputPath: string }>,
  niche: NicheRecord,
  spec: CollectionDesignSpec,
  localDesignPath: string,
  status: ListingRecord["status"],
): { listing: ListingRecord; sectionId: string | null } {
  const copy = buildListingCopy(config, spec);
  const design = createDesignRecord({
    theme: spec.concept,
    productType: config.productType,
    imagePath: localDesignPath,
    printFilePath: localDesignPath,
    llmModelUsed: "deterministic-svg",
    costUsd: 0,
    qualityScore,
    metadata: {
      source: config.loggerName,
      collectionType: `permanent-branded-${config.productType}`,
      designName: spec.name,
    },
  });

  const sectionId = resolveSuggestedSectionId(spec.sectionTitle);
  const listing = createLocalDraftListing({
    nicheId: niche.id,
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
    price: PRODUCT_BASE_PRICES[config.productType],
    status,
    productType: config.productType,
    designId: design.id,
    qualityScore,
    metadata: {
      source: config.loggerName,
      collectionType: `permanent-branded-${config.productType}`,
      designName: spec.name,
      suggestedShopSectionTitle: spec.sectionTitle,
      suggestedShopSectionId: sectionId,
      localDesignPath,
      theme: spec.concept,
    },
  });

  updateListingImagePath(listing.id, localDesignPath);
  return { listing, sectionId };
}

/**
 * Creates a Printful sync product and provider mapping so live publishes already have fulfillment routing in place.
 */
async function preparePrintfulProduct(
  config: DeterministicCollectionConfig<{ id: number; outputPath: string }>,
  listing: ListingRecord,
  localDesignPath: string,
): Promise<PodProductRecord> {
  const resolvedCatalog = await resolvePrintfulCatalogForProductType(config.productType);
  const printfulFile = await uploadPrintfulFile(localDesignPath, basename(localDesignPath));
  const thumbnailUrl = await uploadToImgbb(localDesignPath);
  const fileType = config.productType === "t-shirt" || config.productType === "hoodie" ? "front" : "default";
  const product = await createPrintfulProduct({
    syncProduct: {
      name: listing.title,
      thumbnail: thumbnailUrl,
    },
    syncVariants: resolvedCatalog.variants.map((variant) => ({
      variant_id: variant.id,
      retail_price: listing.price.toFixed(2),
      files: [{ type: fileType, id: printfulFile.id }],
    })),
  });

  const baseCost = config.productType === "hoodie"
    ? 24
    : config.productType === "poster"
      ? 11.5
      : config.productType === "mug"
        ? 6.75
        : 9.25;

  return upsertPodProduct({
    listingId: listing.id,
    printfulProductId: String(product.sync_product?.id ?? product.id),
    blueprintId: resolvedCatalog.blueprintId,
    baseCost,
    retailPrice: listing.price,
    profitMargin: Number(((listing.price - baseCost) / listing.price).toFixed(4)),
    status: "prepared",
    provider: "printful",
    variantId: String(resolvedCatalog.variants[0]?.id ?? ""),
    metadata: {
      uploadedImagePath: localDesignPath,
      uploadProvider: "printful",
      printfulFileId: printfulFile.id,
      printfulFileUrl: printfulFile.url,
      thumbnailUrl,
      blueprintId: resolvedCatalog.blueprintId,
      variantIds: resolvedCatalog.variants.map((variant) => variant.id),
    },
  });
}

/**
 * Processes one deterministic design through preview or live preparation.
 */
async function processCollectionDesign(
  config: DeterministicCollectionConfig<{ id: number; outputPath: string }>,
  spec: CollectionDesignSpec,
  niche: NicheRecord,
  dryRun: boolean,
  logger = createLogger(config.loggerName),
): Promise<CollectionRunItem> {
  const item: CollectionRunItem = {
    designId: spec.id,
    name: spec.name,
    published: false,
    pendingApproval: false,
    errors: [],
  };

  try {
    const generatedAsset = await config.generateDesign(spec.id);
    item.localDesignPath = generatedAsset.outputPath;

    const initialStatus: ListingRecord["status"] = requiresApproval() ? "pending_approval" : "draft";
    const { listing } = createCollectionRecords(config, niche, spec, generatedAsset.outputPath, initialStatus);
    item.listingId = listing.id;

    if (dryRun) {
      item.published = true;
      item.etsyListingId = `dry-run-${config.productType}-${listing.id}`;
      return item;
    }

    if (requiresApproval()) {
      updateListingStatus(listing.id, "pending_approval", {
        ...(listing.metadata ? JSON.parse(listing.metadata) as Record<string, unknown> : {}),
        localDesignPath: generatedAsset.outputPath,
        theme: spec.concept,
        approvalHeld: true,
      });
      item.pendingApproval = true;
      return item;
    }

    const podProduct = await preparePrintfulProduct(config, listing, generatedAsset.outputPath);
    item.printfulProductId = podProduct.printful_product_id ?? undefined;

    const publishResult = await publishListing(listing.id);
    if (!publishResult.success || !publishResult.etsy_listing_id) {
      throw new Error(publishResult.error ?? `Etsy publish failed for the ${config.productType} collection item.`);
    }

    item.etsyListingId = publishResult.etsy_listing_id;
    item.published = true;
    return item;
  } catch (error) {
    item.errors.push(error instanceof Error ? error.message : String(error));
    logger.error("Deterministic branded collection item failed", error, {
      productType: config.productType,
      designNumber: spec.id,
      designName: spec.name,
    });
    return item;
  }
}

/**
 * Runs one deterministic branded product collection in preview or live mode and writes a JSON report.
 */
export async function runDeterministicCollection(
  config: DeterministicCollectionConfig<{ id: number; outputPath: string }>,
  options: CollectionScriptOptions,
): Promise<CollectionRunResult> {
  const logger = createLogger(config.loggerName);
  initializeDatabase();
  if (options.dryRun) {
    process.env.DRY_RUN = "true";
  }

  await mkdir(resolveProjectPath(config.rootDirectory), { recursive: true });
  const niche = resolveCollectionNiche(config.preferredNicheNames);
  const dryRun = options.dryRun || isDryRunEnabled();
  const result: CollectionRunResult = {
    dryRun,
    generatedAt: new Date().toISOString(),
    publishedCount: 0,
    pendingCount: 0,
    items: [],
  };

  for (const spec of config.designs) {
    const item = await processCollectionDesign(config, spec, niche, dryRun, logger);
    if (item.published) {
      result.publishedCount += 1;
    }
    if (item.pendingApproval) {
      result.pendingCount += 1;
    }
    result.items.push(item);
  }

  const reportPath = resolveProjectPath(config.reportPath);
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  logger.action("Deterministic branded collection run completed", "success", {
    productType: config.productType,
    dryRun: result.dryRun,
    publishedCount: result.publishedCount,
    pendingCount: result.pendingCount,
    reportPath,
  });
  return result;
}
