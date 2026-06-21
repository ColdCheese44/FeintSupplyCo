import "dotenv/config";

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  getDesignById,
  getPublishedListings,
  initializeDatabase,
  updateListingPrintfulProductId,
  upsertPodProduct,
  type ListingRecord,
} from "../lib/db.js";
import { recordFailure } from "../lib/dead-letter.js";
import { createLogger } from "../lib/logger.js";
import { resolveAssetPath, toRelativePath } from "../lib/paths.js";
import { createLinkedPrintfulSyncProduct } from "../lib/printful-client.js";

interface BackfillOptions {
  dryRun: boolean;
}

interface BackfillItem {
  listingId: number;
  title: string;
  productType: string;
  etsyListingId: string;
  localDesignPath: string | null;
  status: "would_create" | "created" | "skipped" | "failed";
  reason?: string;
  printfulProductId?: string;
}

interface BackfillReport {
  dryRun: boolean;
  inspected: number;
  matched: number;
  created: number;
  failed: number;
  items: BackfillItem[];
}

const logger = createLogger("backfill-printful-products");

/**
 * Normalizes a candidate local asset path and returns it only when the file exists.
 */
function fixPath(candidatePath: string): string {
  const resolvedCandidatePath = resolveAssetPath(candidatePath);
  if (existsSync(resolvedCandidatePath)) {
    return resolvedCandidatePath;
  }

  const filename = basename(resolvedCandidatePath);
  const folder = basename(dirname(resolvedCandidatePath));
  const candidates = [
    join(process.cwd(), "data", "stickers", folder, filename),
    join(process.cwd(), "data", "designs", folder, filename),
    join(process.cwd(), "data", "tshirts", folder, filename),
  ];

  return candidates.find((entry) => existsSync(entry)) ?? resolvedCandidatePath;
}

/**
 * Normalizes a candidate local asset path and returns it only when the file exists.
 */
function resolveLocalDesignPath(listing: ListingRecord): string | null {
  const designPath = listing.design_id ? getDesignById(listing.design_id)?.image_path ?? null : null;
  const candidate = designPath ?? listing.image_url;
  if (!candidate) {
    return null;
  }

  const resolved = resolveAssetPath(candidate);
  const fixed = fixPath(resolved);
  return existsSync(fixed) ? fixed : null;
}

/**
 * Runs the Printful sync backfill over already-published Etsy listings that do not yet have a stored Printful product ID.
 */
export async function runBackfillPrintfulProducts(options: BackfillOptions): Promise<BackfillReport> {
  initializeDatabase();

  const publishedListings = getPublishedListings().filter((listing) => listing.etsy_listing_id && !listing.printful_product_id);
  const report: BackfillReport = {
    dryRun: options.dryRun,
    inspected: getPublishedListings().length,
    matched: publishedListings.length,
    created: 0,
    failed: 0,
    items: [],
  };

  for (const listing of publishedListings) {
    const localDesignPath = resolveLocalDesignPath(listing);
    const item: BackfillItem = {
      listingId: listing.id,
      title: listing.title,
      productType: listing.product_type ?? "unknown",
      etsyListingId: listing.etsy_listing_id ?? "",
      localDesignPath,
      status: "skipped",
    };

    if (!localDesignPath) {
      item.status = "failed";
      item.reason = "Local design file not found.";
      report.failed += 1;
      report.items.push(item);
      continue;
    }

    if (options.dryRun) {
      item.status = "would_create";
      item.reason = "Dry-run only. No Printful sync product created.";
      report.items.push(item);
      continue;
    }

    try {
      const sync = await createLinkedPrintfulSyncProduct({
        title: listing.title,
        productType: listing.product_type ?? "sticker",
        localImagePath: localDesignPath,
        externalId: listing.etsy_listing_id ?? "",
        retailPrice: listing.price,
      });

      updateListingPrintfulProductId(listing.id, sync.syncProductId);
      upsertPodProduct({
        listingId: listing.id,
        printfulProductId: sync.syncProductId,
        blueprintId: sync.blueprintId,
        baseCost: 0,
        retailPrice: listing.price,
        profitMargin: 0,
        status: "published",
        provider: "printful",
        variantId: sync.syncVariantIds[0] ? String(sync.syncVariantIds[0]) : null,
        metadata: {
          printfulFileId: sync.fileId,
          printfulFileUrl: sync.fileUrl,
          thumbnailUrl: sync.thumbnailUrl,
          blueprintId: sync.blueprintId,
          variantIds: sync.catalogVariantIds,
          syncVariantIds: sync.syncVariantIds,
          externalId: listing.etsy_listing_id,
          uploadedImagePath: toRelativePath(localDesignPath),
          uploadProvider: "printful",
          source: "backfill-printful-products",
        },
      });

      item.status = "created";
      item.printfulProductId = sync.syncProductId;
      report.created += 1;
    } catch (error) {
      item.status = "failed";
      item.reason = error instanceof Error ? error.message : String(error);
      recordFailure(
        "publish",
        item.reason,
        {
          listingId: listing.id,
          title: listing.title,
          productType: listing.product_type ?? "sticker",
          etsyListingId: listing.etsy_listing_id,
          localDesignPath: localDesignPath ? toRelativePath(localDesignPath) : null,
          source: "backfill-printful-products",
        },
        listing.id,
        listing.design_id ?? undefined,
      );
      report.failed += 1;
    }

    report.items.push(item);
  }

  logger.action("Completed Printful sync product backfill", "success", {
    dryRun: report.dryRun,
    inspected: report.inspected,
    matched: report.matched,
    created: report.created,
    failed: report.failed,
  });
  return report;
}

/**
 * Parses CLI flags for backfill preview mode.
 */
function parseArgs(argv: string[]): BackfillOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Detects direct execution so the backfill script can run through npm scripts.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  try {
    const result = await runBackfillPrintfulProducts(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.error("Standalone backfill-printful-products execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
