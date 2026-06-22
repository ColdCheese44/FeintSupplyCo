import "dotenv/config";

import { existsSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getListingById, getRecentResearchResultsForNiche, initializeDatabase, markListingFailed, markListingPublished } from "../lib/db.js";
import { activateListing, createDraftListing, uploadListingImage } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { auditLog } from "../lib/audit.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface PublishResult {
  success: boolean;
  etsy_listing_id?: string;
  listing_url?: string;
  error?: string;
}

export interface PublishListingOptions {
  imagePathOverride?: string;
  descriptionOverride?: string;
}

const logger = createLogger("etsy-publish");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Splits the database tag string into the list Etsy expects in its listing payload.
 */
function parseTags(tagString: string): string[] {
  return tagString
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Normalizes a stored image path so publish runs remain stable regardless of current working directory.
 */
function resolveStoredImagePath(candidatePath: string): string {
  return isAbsolute(candidatePath) ? candidatePath : resolve(projectRoot, candidatePath);
}

/**
 * Pulls the most recent taxonomy ID seen during research so publish requests are grounded in marketplace data.
 */
function resolveTaxonomyId(nicheId: number): number | null {
  const recentResults = getRecentResearchResultsForNiche(nicheId, 5);

  for (const result of recentResults) {
    const rawData = JSON.parse(result.raw_data) as { sampleListings?: Array<{ taxonomy_id?: number }> };
    for (const listing of rawData.sampleListings ?? []) {
      if (typeof listing.taxonomy_id === "number" && listing.taxonomy_id > 0) {
        return listing.taxonomy_id;
      }
    }
  }

  const fallback = Number(process.env.ETSY_DEFAULT_TAXONOMY_ID ?? "");
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Reads an optional integer configuration value from the environment without crashing on missing input.
 */
function readOptionalIntegerEnv(name: string): number | undefined {
  const parsed = Number(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Performs the publish quality gate so invalid listings do not hit the Etsy API.
 */
function validateListingForPublish(title: string, description: string, tags: string[], imagePath: string): void {
  if (!title || title.length > 140) {
    throw new Error("Listing title failed publish validation.");
  }
  if (description.length <= 200) {
    throw new Error("Listing description failed publish validation.");
  }
  if (tags.length < 1 || tags.length > 13) {
    throw new Error("Listing must contain between 1 and 13 tags before publishing.");
  }
  if (!existsSync(imagePath)) {
    throw new Error(`Listing image does not exist at ${imagePath}.`);
  }
}

/**
 * Publishes a local draft listing to Etsy, uploads its image, and marks it active on success.
 */
export async function publishListing(listingId: number, options: PublishListingOptions = {}): Promise<PublishResult> {
  if (isDryRunEnabled()) {
    const result: PublishResult = {
      success: true,
      etsy_listing_id: `dry-run-${listingId}`,
      listing_url: `https://www.etsy.com/listing/dry-run-${listingId}`,
    };
    logger.action("Dry-run Etsy publish completed", "skip", { listingId, result });
    return result;
  }

  initializeDatabase();
  const listing = getListingById(listingId);

  if (!listing) {
    throw new Error(`Listing ${listingId} was not found in the local database.`);
  }

  if (!listing.image_url) {
    throw new Error(`Listing ${listingId} does not have a generated image path yet.`);
  }

  const tags = parseTags(listing.tags);
  const imagePath = options.imagePathOverride
    ? resolveStoredImagePath(options.imagePathOverride)
    : resolveStoredImagePath(listing.image_url);
  const description = options.descriptionOverride ?? listing.description;
  const taxonomyId = resolveTaxonomyId(listing.niche_id);
  const listingType = (process.env.ETSY_LISTING_TYPE?.trim().toLowerCase() === "download" ? "download" : "physical") as
    | "download"
    | "physical";

  validateListingForPublish(listing.title, description, tags, imagePath);

  if (!taxonomyId) {
    throw new Error("No Etsy taxonomy ID was available from research results. Run research first or set ETSY_DEFAULT_TAXONOMY_ID.");
  }

  if (listingType === "physical") {
    const shippingProfileId = readOptionalIntegerEnv("ETSY_SHIPPING_PROFILE_ID");
    const readinessStateId = readOptionalIntegerEnv("ETSY_READINESS_STATE_ID");
    if (!shippingProfileId || !readinessStateId) {
      throw new Error(
        "Physical Etsy publishing requires ETSY_SHIPPING_PROFILE_ID and ETSY_READINESS_STATE_ID to be available in the environment.",
      );
    }
  }

  try {
    logger.action("Publishing draft listing to Etsy", "start", {
      listingId,
      title: listing.title,
      taxonomyId,
      listingType,
      imagePath,
      imagePathOverridden: Boolean(options.imagePathOverride),
      descriptionOverridden: Boolean(options.descriptionOverride),
    });
    const draftListing = await createDraftListing({
      title: listing.title,
      description,
      price: listing.price,
      taxonomyId,
      quantity: 999,
      tags,
      type: listingType,
      shippingProfileId: readOptionalIntegerEnv("ETSY_SHIPPING_PROFILE_ID"),
      readinessStateId: readOptionalIntegerEnv("ETSY_READINESS_STATE_ID"),
    });

    await uploadListingImage(draftListing.listing_id, imagePath);
    const publishResult = await activateListing(draftListing.listing_id);
    markListingPublished(listingId, publishResult.etsyListingId);

    const result: PublishResult = {
      success: true,
      etsy_listing_id: publishResult.etsyListingId,
      listing_url: publishResult.listingUrl,
    };
    auditLog("publish", "feintsupply", {
      etsyListingId: publishResult.etsyListingId,
      listingUrl: publishResult.listingUrl,
    }, listingId, listing.design_id ?? undefined);
    logger.action("Listing published to Etsy", "success", result);
    return result;
  } catch (error) {
    markListingFailed(listingId);
    logger.error("Listing publish failed", error, { listingId });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parses CLI arguments for the standalone publish entry point.
 */
function parseCliArgs(argv: string[]): { listingId: number } {
  const listingIdIndex = argv.findIndex((argument) => argument === "--listing-id");
  const listingId = listingIdIndex >= 0 ? Number.parseInt(argv[listingIdIndex + 1] ?? "", 10) : Number.NaN;

  if (!Number.isFinite(listingId)) {
    throw new Error("Missing required --listing-id argument for publish.");
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
 * Runs the standalone publish entry point and prints the Etsy publish result as JSON.
 */
async function main(): Promise<void> {
  try {
    const { listingId } = parseCliArgs(process.argv.slice(2));
    const result = await publishListing(listingId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error("Standalone publish execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
