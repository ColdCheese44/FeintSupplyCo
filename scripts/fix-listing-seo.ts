import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  listActiveShopListings,
  updateListingTags,
  updateListingTaxonomy,
  uploadListingImage,
  type EtsyActiveListing,
} from "../lib/etsy-client.js";
import { callLLM } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";

/**
 * Repairs the three search-visibility problems Etsy itself reports on live listings:
 * listings parked on the root taxonomy node, identical tag sets competing with each other,
 * and listings carrying a single photo.
 *
 * Safe to re-run. Each phase checks current state before writing.
 */

const logger = createLogger("fix-listing-seo");

/** Etsy taxonomy: Craft Supplies & Tools > Scrapbooking > Stickers, Labels & Tags > Stickers. */
const STICKER_TAXONOMY_ID = 1326;
const ROOT_TAXONOMY_ID = 1;

const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;
const MOCKUPS_PER_LISTING = 2;

interface TagPlan {
  listingId: number;
  tags: string[];
}

/**
 * Etsy rejects tags over 20 characters or carrying punctuation, and caps them at 13 per listing.
 */
function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];

  for (const raw of tags) {
    const tag = raw
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    clean.push(tag);
    if (clean.length === MAX_TAGS) {
      break;
    }
  }

  return clean;
}

/**
 * Asks Claude for one differentiated tag set per listing in a single call, so the model can
 * see every title at once and deliberately avoid overlap between them.
 */
async function planTags(listings: EtsyActiveListing[]): Promise<TagPlan[]> {
  const roster = listings
    .map((listing) => `- id ${listing.listing_id}: "${listing.title}"`)
    .join("\n");

  const prompt = `These Etsy listings all currently share one identical tag set, so they compete against each other for the same searches instead of covering different ones.

Listings:
${roster}

Write a distinct set of exactly ${MAX_TAGS} Etsy tags for each listing.

Rules:
- Each tag is at most ${MAX_TAG_LENGTH} characters, lowercase, letters/numbers/spaces only.
- At most 4 tags may be shared across all listings (broad category terms such as "vinyl sticker").
- The remaining tags must be specific to that individual design and differ between listings.
- Target real buyer search phrases, not brand slogans.
- Shop context: veteran and former law enforcement owned, cybersecurity and tech culture, dark minimal aesthetic. Die-cut vinyl laptop stickers.

Return ONLY a JSON array, no prose, no markdown fence:
[{"listingId": <number>, "tags": ["tag one", "tag two", ...]}]`;

  const response = await callLLM({
    taskType: "listing_copywriting",
    prompt,
    maxTokens: 4000,
    expectJson: true,
  });

  const parsed = JSON.parse(response.text ?? "[]") as TagPlan[];
  return parsed.map((plan) => ({
    listingId: Number(plan.listingId),
    tags: sanitizeTags(plan.tags ?? []),
  }));
}

/**
 * Builds a mockup prompt that shows the sticker in a real buying context rather than as flat art.
 */
function buildMockupPrompt(title: string, variation: number): string {
  const design = title.replace(/^Feint Supply Co\.\s*-\s*/i, "").replace(/\s*Sticker$/i, "");
  const scenes = [
    `A die-cut matte vinyl sticker reading "${design}" applied to the lid of a dark grey laptop on a clean desk, shallow depth of field, moody natural side light, photorealistic product photography`,
    `A die-cut matte vinyl sticker reading "${design}" held between finger and thumb against a plain concrete background, crisp focus on the sticker, soft daylight, photorealistic product photography`,
  ];
  return scenes[(variation - 1) % scenes.length];
}

/**
 * Generates and uploads supporting mockups so each listing carries more than one photo.
 */
async function addMockups(listing: EtsyActiveListing, dryRun: boolean): Promise<number> {
  const outputDir = resolve(process.cwd(), "data", "mockups", String(listing.listing_id));
  await mkdir(outputDir, { recursive: true });

  let uploaded = 0;
  for (let variation = 1; variation <= MOCKUPS_PER_LISTING; variation += 1) {
    const destinationPath = resolve(outputDir, `mockup-${variation}.png`);
    const prompt = buildMockupPrompt(listing.title, variation);

    if (dryRun) {
      console.log(`      [dry-run] would generate + upload mockup ${variation}`);
      continue;
    }

    try {
      const result = await callLLM({
        taskType: "photorealistic_mockups",
        prompt,
        destinationPath,
      });
      await uploadListingImage(listing.listing_id, destinationPath);
      uploaded += 1;
      console.log(`      uploaded mockup ${variation} (${result.provider}/${result.model}, $${result.costUsd})`);
    } catch (error) {
      console.log(`      mockup ${variation} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return uploaded;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipImages = args.includes("--skip-images");

  console.log(`\nfix-listing-seo${dryRun ? " (DRY RUN)" : ""}${skipImages ? " [skipping images]" : ""}\n`);

  const listings = await listActiveShopListings();
  console.log(`Found ${listings.length} active listings.\n`);

  // Phase 1 - category
  console.log("Phase 1: taxonomy");
  let taxonomyFixed = 0;
  for (const listing of listings) {
    if (listing.taxonomy_id && listing.taxonomy_id !== ROOT_TAXONOMY_ID) {
      console.log(`  ${listing.listing_id} already on taxonomy ${listing.taxonomy_id}, skipping`);
      continue;
    }
    if (dryRun) {
      console.log(`  [dry-run] ${listing.listing_id} -> taxonomy ${STICKER_TAXONOMY_ID}`);
      continue;
    }
    try {
      await updateListingTaxonomy(listing.listing_id, STICKER_TAXONOMY_ID);
      taxonomyFixed += 1;
      console.log(`  ${listing.listing_id} -> taxonomy ${STICKER_TAXONOMY_ID}`);
    } catch (error) {
      console.log(`  ${listing.listing_id} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase 2 - tags
  console.log("\nPhase 2: differentiated tags");
  const plans = await planTags(listings);
  let tagsFixed = 0;
  for (const plan of plans) {
    const listing = listings.find((item) => item.listing_id === plan.listingId);
    if (!listing) {
      console.log(`  skipping unknown listing id ${plan.listingId}`);
      continue;
    }
    console.log(`  ${listing.title.slice(0, 44)}`);
    console.log(`    ${plan.tags.join(", ")}`);
    if (dryRun) {
      continue;
    }
    try {
      await updateListingTags(plan.listingId, plan.tags);
      tagsFixed += 1;
    } catch (error) {
      console.log(`    FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase 3 - photos
  let imagesUploaded = 0;
  if (!skipImages) {
    console.log("\nPhase 3: mockup photos");
    for (const listing of listings) {
      console.log(`  ${listing.title.slice(0, 44)}`);
      imagesUploaded += await addMockups(listing, dryRun);
    }
  }

  console.log("\n--- summary ---");
  console.log(`  taxonomy updated: ${taxonomyFixed}`);
  console.log(`  tag sets updated: ${tagsFixed}`);
  console.log(`  images uploaded:  ${imagesUploaded}`);
  logger.action("fix-listing-seo completed", "success", { taxonomyFixed, tagsFixed, imagesUploaded, dryRun });
}

main().catch((error) => {
  logger.error("fix-listing-seo failed", error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
