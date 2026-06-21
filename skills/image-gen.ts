import "dotenv/config";

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getListingById, getNicheById, initializeDatabase, updateListingImagePath } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { generateImageToPath } from "../lib/replicate-client.js";
import { ensureDryRunImage, isDryRunEnabled } from "../lib/runtime.js";

const logger = createLogger("image-gen");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Creates a store-ready product mockup prompt from the listing title and niche context.
 */
function buildImagePrompt(listingTitle: string, nicheName: string): string {
  return `Create a premium Etsy product hero image for "${listingTitle}" in the "${nicheName}" niche. Use a clean studio mockup, polished lighting, crisp typography or artwork detail, a marketplace-friendly composition, and a neutral background that keeps the product as the focal point. Output a realistic ecommerce-ready still image.`;
}

/**
 * Normalizes image paths so the database can store either absolute or project-relative values safely.
 */
function resolveImagePath(candidatePath: string): string {
  return isAbsolute(candidatePath) ? candidatePath : resolve(projectRoot, candidatePath);
}

/**
 * Generates a listing image with Replicate, saves it locally, and updates the listing record.
 */
export async function generateListingImage(listingId: number): Promise<string> {
  if (isDryRunEnabled()) {
    const outputPath = resolve(projectRoot, "data", "images", `${listingId}.png`);
    await ensureDryRunImage(outputPath);
    logger.action("Dry-run product image generated", "skip", { listingId, outputPath });
    return outputPath;
  }

  initializeDatabase();
  const listing = getListingById(listingId);
  if (!listing) {
    throw new Error(`Listing ${listingId} was not found in the local database.`);
  }

  const niche = getNicheById(listing.niche_id);
  if (!niche) {
    throw new Error(`Niche ${listing.niche_id} could not be resolved for listing ${listingId}.`);
  }

  const outputPath = resolve(projectRoot, "data", "images", `${listingId}.png`);
  logger.action("Generating product image", "start", { listingId, outputPath });

  const imagePath = await generateImageToPath(buildImagePrompt(listing.title, niche.name), {
    destinationPath: outputPath,
  });

  updateListingImagePath(listingId, imagePath);
  logger.action("Stored generated product image path", "success", { listingId, imagePath, exists: existsSync(resolveImagePath(imagePath)) });
  return imagePath;
}

/**
 * Parses CLI arguments for the standalone image generation entry point.
 */
function parseCliArgs(argv: string[]): { listingId: number } {
  const listingIdIndex = argv.findIndex((argument) => argument === "--listing-id");
  const listingId = listingIdIndex >= 0 ? Number.parseInt(argv[listingIdIndex + 1] ?? "", 10) : Number.NaN;

  if (!Number.isFinite(listingId)) {
    throw new Error("Missing required --listing-id argument for image generation.");
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
 * Runs the standalone image generation entry point and prints the saved file path.
 */
async function main(): Promise<void> {
  try {
    const { listingId } = parseCliArgs(process.argv.slice(2));
    const imagePath = await generateListingImage(listingId);
    console.log(imagePath);
  } catch (error) {
    logger.error("Standalone image generation failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
