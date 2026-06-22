import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDesignRecord,
  createDraftListing as createLocalDraftListing,
  getActiveNiches,
  getShopSections,
  initializeDatabase,
  resolveProjectPath,
  updateListingDesignReference,
  updateListingImagePath,
  updateListingStatus,
  upsertPodProduct,
  type ListingRecord,
  type NicheRecord,
  type PodProductRecord,
} from "../lib/db.js";
import { generateTshirtDesign } from "../lib/brand-compositor.js";
import { recordFailure } from "../lib/dead-letter.js";
import { appendAiDisclosure } from "../lib/legal-filter.js";
import { createLogger } from "../lib/logger.js";
import { uploadToImgbb } from "../lib/imgbb-client.js";
import { resolveAssetPath, toRelativePath } from "../lib/paths.js";
import {
  createPrintfulProduct,
  getCatalogProductVariants,
  printfulProductLabel,
  searchCatalogProducts,
  uploadFile as uploadPrintfulFile,
  type PrintfulCatalogProduct,
  type PrintfulCatalogVariant,
  type PrintfulFileUploadResult,
} from "../lib/printful-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { publishListing } from "../skills/etsy-publish.js";
import { validateTags } from "../skills/listing-gen.js";

interface TshirtScriptOptions {
  dryRun: boolean;
}

interface TshirtDesignSpec {
  id: number;
  name: string;
  concept: string;
  sectionTitle: string;
}

interface TshirtRunItem {
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

interface TshirtRunResult {
  dryRun: boolean;
  generatedAt: string;
  publishedCount: number;
  pendingCount: number;
  items: TshirtRunItem[];
}

interface CachedTshirtCatalog {
  product: PrintfulCatalogProduct;
  variants: PrintfulCatalogVariant[];
}

const logger = createLogger("generate-tshirt-collection");
const tshirtRoot = resolveProjectPath("data/tshirts");
let cachedCatalog: CachedTshirtCatalog | null = null;

const tshirtDesigns: TshirtDesignSpec[] = [
  {
    id: 1,
    name: "Signal Wordmark",
    concept: "Clean wordmark chest print with FEINT SUPPLY CO. framed by thin cyan rules and SIGNAL OVER NOISE. beneath it.",
    sectionTitle: "Signal & Noise",
  },
  {
    id: 2,
    name: "Redacted",
    concept: "Redacted wordmark concept with a CLASSIFIED stamp, built around the investigator side of the brand.",
    sectionTitle: "Investigator Files",
  },
  {
    id: 3,
    name: "Operationally Sound",
    concept: "Dry humor typography piece balancing OPERATIONALLY SOUND. with EMOTIONALLY QUESTIONABLE.",
    sectionTitle: "Dark Humor",
  },
  {
    id: 4,
    name: "Terminal Status",
    concept: "Terminal-style status block with operator and signal language in a green monospace treatment.",
    sectionTitle: "SOC + Cyber",
  },
  {
    id: 5,
    name: "FSC Chevron",
    concept: "Minimal chest print with a large amber chevron, FEINT SUPPLY CO., and EST. 2026 below it.",
    sectionTitle: "Veteran Mindset",
  },
  {
    id: 6,
    name: "After Action",
    concept: "After action report style design with SURVIVED ANOTHER ONE as the understated payoff line.",
    sectionTitle: "Field Notes",
  },
];

const defaultTshirtTags = [
  "feint supply",
  "veteran shirt",
  "cyber tee",
  "operator shirt",
  "tactical tee",
  "dark humor",
  "graphic tee",
  "veteran owned",
  "unisex tee",
];

/**
 * Returns whether generated t-shirt listings should pause for manual approval instead of publishing to Etsy immediately.
 */
function requiresApproval(): boolean {
  return (process.env.REQUIRE_APPROVAL ?? "").trim().toLowerCase() === "true";
}

/**
 * Picks the best brand-fit niche for the permanent t-shirt collection.
 */
function resolveTshirtNiche(): NicheRecord {
  const activeNiches = getActiveNiches();
  const preferredNames = [
    "Veteran Owned Brand",
    "Cybersecurity Culture",
    "Quiet Professional",
    "Tech Veteran Crossover",
  ];

  for (const name of preferredNames) {
    const match = activeNiches.find((niche) => niche.name.toLowerCase() === name.toLowerCase());
    if (match) {
      return match;
    }
  }

  if (activeNiches.length === 0) {
    throw new Error("No active niches were available for the t-shirt collection.");
  }

  return activeNiches[0];
}

/**
 * Generates deterministic listing copy so preview runs stay reliable and cost-free.
 */
function buildListingCopy(spec: TshirtDesignSpec): { title: string; description: string; tags: string[] } {
  const title = `Feint Supply Co. - ${spec.name} | Veteran Cybersecurity Graphic Tee`;
  const body = [
    `${spec.name} is built for people who know how to keep their mouth shut, their kit squared away, and their sense of humor intact. This Feint Supply Co. graphic tee leans into ${spec.concept.toLowerCase()} without turning into costume-shop operator cosplay.`,
    `The shirt uses a clean unisex fit with direct-to-garment print detail suited for daily wear, range-bag runs, desk shifts, or the kind of off-hours decompression that starts with dark coffee and ends with black humor. Sizes run from S through 2XL, and the design keeps the chest print sharp without cluttering the rest of the garment.`,
    `Every order is made to order and fulfilled through our production partner, with standard production time of 3-5 business days before shipment. The artwork is AI-assisted, but the direction, curation, and final concept come from the same brand voice that built Feint Supply Co. in the first place. Practical. Quiet. Built for people who already get it.`,
  ].join("\n\n");

  return {
    title,
    description: appendAiDisclosure(body),
    tags: validateTags(defaultTshirtTags),
  };
}

/**
 * Chooses the suggested Etsy section ID from the locally cached shop sections when present.
 */
function resolveSuggestedSectionId(sectionTitle: string): string | null {
  const section = getShopSections().find((entry) => entry.title.toLowerCase() === sectionTitle.toLowerCase());
  return section ? String(section.etsy_section_id) : null;
}

/**
 * Finds and caches a suitable Printful unisex t-shirt blueprint for the entire collection.
 */
async function loadCachedTshirtCatalog(): Promise<CachedTshirtCatalog> {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const payload = await searchCatalogProducts("unisex t-shirt");
  const product = (payload.data ?? []).find((entry) => {
    const name = printfulProductLabel(entry).toLowerCase();
    return name.includes("bella") || name.includes("gildan") || name.includes("unisex");
  });

  if (!product) {
    throw new Error("No suitable Printful unisex t-shirt blueprint was found.");
  }

  const variants = await getCatalogProductVariants(product.id);
  const wantedSizes = new Set(["s", "m", "l", "xl", "2xl"]);
  const filteredVariants = variants.filter((variant) => {
    const name = variant.name?.toLowerCase() ?? "";
    const color = variant.color?.toLowerCase() ?? "";
    const colorCode = variant.color_code?.toLowerCase() ?? "";
    const size = (variant.size ?? "").toLowerCase();
    const isBlack = color.includes("black") || colorCode.includes("000000") || name.includes("black");
    const isWantedSize = wantedSizes.has(size) || [...wantedSizes].some((wanted) => name.includes(` ${wanted}`));
    return isBlack && isWantedSize;
  });

  if (filteredVariants.length === 0) {
    throw new Error(`Printful product ${product.id} did not expose black S-2XL variants.`);
  }

  cachedCatalog = { product, variants: filteredVariants };
  return cachedCatalog;
}

/**
 * Creates the local design and listing records that the approval workflow will publish later.
 */
function createTshirtRecords(
  niche: NicheRecord,
  spec: TshirtDesignSpec,
  localDesignPath: string,
  status: ListingRecord["status"],
): { listing: ListingRecord; sectionId: string | null } {
  const copy = buildListingCopy(spec);
  const design = createDesignRecord({
    theme: spec.concept,
    productType: "t-shirt",
    imagePath: localDesignPath,
    printFilePath: localDesignPath,
    llmModelUsed: "deterministic-svg",
    costUsd: 0,
    qualityScore: 0.96,
    metadata: {
      source: "generate-tshirt-collection",
      collectionType: "permanent-branded-tshirts",
      tshirtDesignName: spec.name,
    },
  });

  const sectionId = resolveSuggestedSectionId(spec.sectionTitle);
  const listing = createLocalDraftListing({
    nicheId: niche.id,
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
    price: 29.99,
    status,
    productType: "t-shirt",
    designId: design.id,
    qualityScore: 0.96,
    metadata: {
      source: "generate-tshirt-collection",
      collectionType: "permanent-branded-tshirts",
      tshirtDesignName: spec.name,
      suggestedShopSectionTitle: spec.sectionTitle,
      suggestedShopSectionId: sectionId,
      localDesignPath: toRelativePath(localDesignPath),
      theme: spec.concept,
    },
  });

  updateListingImagePath(listing.id, localDesignPath);
  updateListingDesignReference(listing.id, design.id, "t-shirt", 0.96);
  return { listing, sectionId };
}

/**
 * Creates a Printful sync product for the design and stores the provider mapping locally so approval can reuse it later.
 */
async function preparePrintfulProduct(listing: ListingRecord, localDesignPath: string): Promise<PodProductRecord> {
  const normalizedDesignPath = resolveAssetPath(localDesignPath);
  const catalog = await loadCachedTshirtCatalog();
  const printfulFile = await uploadPrintfulFile(normalizedDesignPath, basename(normalizedDesignPath));
  const thumbnailUrl = await uploadToImgbb(normalizedDesignPath);
  const product = await createPrintfulProduct({
    syncProduct: {
      name: listing.title,
      thumbnail: thumbnailUrl,
    },
    syncVariants: catalog.variants.map((variant) => ({
      variant_id: variant.id,
      retail_price: "29.99",
      files: [{ type: "front", id: printfulFile.id }],
    })),
  });

  return upsertPodProduct({
    listingId: listing.id,
    printfulProductId: String(product.sync_product?.id ?? product.id),
    blueprintId: catalog.product.id,
    baseCost: 9.25,
    retailPrice: 29.99,
    profitMargin: Number(((29.99 - 9.25) / 29.99).toFixed(4)),
    status: "prepared",
    provider: "printful",
    variantId: String(catalog.variants[0]?.id ?? ""),
    metadata: {
      uploadedImagePath: toRelativePath(normalizedDesignPath),
      uploadProvider: "printful",
      printfulFileId: printfulFile.id,
      printfulFileUrl: printfulFile.url,
      thumbnailUrl,
      variantIds: catalog.variants.map((variant) => variant.id),
    },
  });
}

/**
 * Processes one deterministic t-shirt design through preview or live preparation.
 */
async function processTshirtDesign(spec: TshirtDesignSpec, niche: NicheRecord, dryRun: boolean): Promise<TshirtRunItem> {
  const item: TshirtRunItem = {
    designId: spec.id,
    name: spec.name,
    published: false,
    pendingApproval: false,
    errors: [],
  };

  try {
    const generatedAsset = await generateTshirtDesign(spec.id);
    item.localDesignPath = generatedAsset.outputPath;

    const requireApproval = requiresApproval();
    const initialStatus: ListingRecord["status"] = requireApproval ? "pending_approval" : "draft";
    const { listing } = createTshirtRecords(niche, spec, generatedAsset.outputPath, initialStatus);
    item.listingId = listing.id;

    if (dryRun) {
      item.published = true;
      item.etsyListingId = `dry-run-tshirt-${listing.id}`;
      return item;
    }

    if (requireApproval) {
      updateListingStatus(listing.id, "pending_approval", {
        ...(listing.metadata ? JSON.parse(listing.metadata) as Record<string, unknown> : {}),
        localDesignPath: toRelativePath(generatedAsset.outputPath),
        theme: spec.concept,
        approvalHeld: true,
      });
      logger.info(`T-shirt held for approval: ${listing.title}`, {
        listingId: listing.id,
        productType: "t-shirt",
      });
      item.pendingApproval = true;
      return item;
    }

    const podProduct = await preparePrintfulProduct(listing, generatedAsset.outputPath);
    item.printfulProductId = podProduct.printful_product_id ?? undefined;

    const publishResult = await publishListing(listing.id);
    if (!publishResult.success || !publishResult.etsy_listing_id) {
      throw new Error(publishResult.error ?? "Etsy publish failed for the t-shirt collection item.");
    }

    item.etsyListingId = publishResult.etsy_listing_id;
    item.published = true;
    return item;
  } catch (error) {
    item.errors.push(error instanceof Error ? error.message : String(error));
    recordFailure(
      "publish",
      item.errors[item.errors.length - 1] ?? "T-shirt collection item failed.",
      {
        designNumber: spec.id,
        designName: spec.name,
        localDesignPath: item.localDesignPath ? toRelativePath(item.localDesignPath) : null,
        listingId: item.listingId ?? null,
        source: "generate-tshirt-collection",
      },
      item.listingId,
      spec.id,
    );
    logger.error("T-shirt collection item failed", error, {
      designNumber: spec.id,
      designName: spec.name,
    });
    return item;
  }
}

/**
 * Runs the permanent Feint t-shirt collection generation flow in preview or live mode.
 */
export async function runTshirtCollection(options: TshirtScriptOptions): Promise<TshirtRunResult> {
  initializeDatabase();
  if (options.dryRun) {
    process.env.DRY_RUN = "true";
  }

  await mkdir(tshirtRoot, { recursive: true });
  const niche = resolveTshirtNiche();
  const dryRun = options.dryRun || isDryRunEnabled();
  const result: TshirtRunResult = {
    dryRun,
    generatedAt: new Date().toISOString(),
    publishedCount: 0,
    pendingCount: 0,
    items: [],
  };

  for (const spec of tshirtDesigns) {
    const item = await processTshirtDesign(spec, niche, dryRun);
    if (item.published) {
      result.publishedCount += 1;
    }
    if (item.pendingApproval) {
      result.pendingCount += 1;
    }
    result.items.push(item);
  }

  const reportPath = resolveProjectPath("data/tshirts/tshirt-collection-report.json");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  logger.action("T-shirt collection run completed", "success", {
    dryRun: result.dryRun,
    publishedCount: result.publishedCount,
    pendingCount: result.pendingCount,
    reportPath,
  });
  return result;
}

/**
 * Parses CLI flags for preview mode.
 */
function parseCliArgs(argv: string[]): TshirtScriptOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Detects direct execution so npm scripts can invoke the t-shirt generator cleanly.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Standalone entry point for the permanent t-shirt catalog flow.
 */
async function main(): Promise<void> {
  try {
    const result = await runTshirtCollection(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    recordFailure(
      "publish",
      error instanceof Error ? error.message : String(error),
      {
        source: "generate-tshirt-collection:main",
        dryRun: parseCliArgs(process.argv.slice(2)).dryRun,
      },
    );
    logger.error("Standalone t-shirt generation failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
