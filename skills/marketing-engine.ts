import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createMarketingEvent,
  getPendingMarketingEvents,
  getPodProductByListingId,
  getRecentlyPublishedListings,
  getWeeklyMarketingSpend,
  initializeDatabase,
  markMarketingEventPublished,
  resolveProjectPath,
} from "../lib/db.js";
import { callLLM } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";
import { createPinterestPin } from "../lib/pinterest-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface MarketingEngineSummary {
  scheduledPins: number;
  publishedPins: number;
  emailDrafts: number;
  failures: string[];
}

const logger = createLogger("marketing-engine");

/**
 * Builds a short Pinterest copy prompt so each pin gets a slightly different SEO angle.
 */
function buildPinterestCopyPrompt(title: string, variation: number): string {
  return `Write a Pinterest pin description for Etsy product "${title}". Variation ${variation}. Keep it under 300 characters, include search-friendly keywords, and end with a soft call to click through. Return plain text only.`;
}

/**
 * Builds a visual prompt for a pin-style promo image based on the listing title and product type.
 */
function buildPinVisualPrompt(title: string, productType: string, variation: number): string {
  return `Create a vertical Pinterest promo image for the Etsy ${productType} "${title}". Variation ${variation}. Use bold readable text overlays, a strong focal point, and a clean callout layout that feels premium but scroll-stopping.`;
}

/**
 * Prevents new paid marketing actions from starting once the weekly marketing budget is exhausted.
 */
function assertMarketingBudgetAvailable(): void {
  const currentSpend = getWeeklyMarketingSpend();
  const weeklyBudget = Number.parseFloat(process.env.WEEKLY_AD_BUDGET_USD ?? "20");
  if (currentSpend > weeklyBudget) {
    throw new Error(`Weekly marketing budget exceeded. Current spend ${currentSpend.toFixed(2)} / ${weeklyBudget.toFixed(2)}.`);
  }
}

/**
 * Returns a remote image URL for Pinterest posting when one is available from existing listing or POD metadata.
 */
function resolveRemoteImageUrl(listingId: number, listingImageUrl: string | null): string | null {
  if (listingImageUrl?.startsWith("http")) {
    return listingImageUrl;
  }

  const podProduct = getPodProductByListingId(listingId);
  if (!podProduct?.metadata) {
    return null;
  }

  const metadata = JSON.parse(podProduct.metadata) as { printifyPreviewUrl?: string };
  return metadata.printifyPreviewUrl ?? null;
}

/**
 * Schedules three Pinterest pins for each new listing and generates the required local image assets.
 */
async function schedulePinsForNewListings(): Promise<number> {
  const listings = getRecentlyPublishedListings(96);
  let scheduledPins = 0;

  for (const listing of listings) {
    const imageDirectory = resolveProjectPath(`data/designs/listing-${listing.id}-pins`);
    await mkdir(imageDirectory, { recursive: true });
    const remoteImageUrl = resolveRemoteImageUrl(listing.id, listing.image_url);

    for (let variation = 1; variation <= 3; variation += 1) {
      const pinImagePath = resolve(imageDirectory, `pin-${variation}.png`);
      await callLLM({
        taskType: "photorealistic_mockups",
        prompt: buildPinVisualPrompt(listing.title, listing.product_type ?? "product", variation),
        destinationPath: pinImagePath,
        size: "1024x1536",
      });

      const descriptionResult = await callLLM({
        taskType: "product_description_seo",
        prompt: buildPinterestCopyPrompt(listing.title, variation),
        maxTokens: 180,
      });

      const scheduledFor = new Date(Date.now() + (variation - 1) * 2 * 24 * 60 * 60 * 1000).toISOString();
      createMarketingEvent({
        listingId: listing.id,
        channel: "pinterest",
        action: "scheduled_pin",
        scheduledFor,
        payload: {
          title: listing.title,
          description: descriptionResult.text ?? "",
          link: listing.etsy_listing_id ? `https://www.etsy.com/listing/${listing.etsy_listing_id}` : undefined,
          localPinPath: pinImagePath,
          remoteImageUrl,
        },
      });
      scheduledPins += 1;
    }
  }

  return scheduledPins;
}

/**
 * Publishes any due Pinterest events that already have a remote image URL available.
 */
async function publishDuePins(): Promise<number> {
  const pendingEvents = getPendingMarketingEvents(50).filter((event) => event.channel === "pinterest");
  let publishedPins = 0;

  for (const event of pendingEvents) {
    try {
      const payload = event.payload ? (JSON.parse(event.payload) as { title?: string; description?: string; link?: string; remoteImageUrl?: string }) : {};
      if (!payload.remoteImageUrl) {
        continue;
      }

      const pin = await createPinterestPin({
        title: payload.title ?? "Jarvis Etsy Drop",
        description: payload.description ?? "",
        link: payload.link,
        imageUrl: payload.remoteImageUrl,
      });
      markMarketingEventPublished(event.id, pin.id);
      publishedPins += 1;
    } catch (error) {
      logger.error("Failed to publish a scheduled Pinterest event", error, { eventId: event.id });
    }
  }

  return publishedPins;
}

/**
 * Generates a lightweight weekly email draft covering the top new listings even without an outbound ESP.
 */
async function draftWeeklyEmailCampaign(): Promise<number> {
  const listings = getRecentlyPublishedListings(168).slice(0, 5);
  if (listings.length === 0) {
    return 0;
  }

  const summaryPrompt = `Write a short ecommerce email campaign featuring these new Etsy products. Use a warm, curiosity-driven tone and include a subject line plus body copy. Return plain text only.\n\n${listings
    .map((listing, index) => `${index + 1}. ${listing.title}`)
    .join("\n")}`;
  const result = await callLLM({
    taskType: "listing_copywriting",
    prompt: summaryPrompt,
    maxTokens: 500,
  });

  createMarketingEvent({
    channel: "email",
    action: "draft_campaign",
    status: "drafted",
    payload: {
      listingIds: listings.map((listing) => listing.id),
      content: result.text ?? "",
    },
  });
  return 1;
}

/**
 * Runs the marketing automation pass for newly published listings and any due Pinterest posts.
 */
export async function runMarketingEngine(): Promise<MarketingEngineSummary> {
  if (isDryRunEnabled()) {
    const summary: MarketingEngineSummary = {
      scheduledPins: 3,
      publishedPins: 0,
      emailDrafts: 1,
      failures: [],
    };
    logger.action("Dry-run marketing engine completed", "skip", summary);
    return summary;
  }

  initializeDatabase();
  assertMarketingBudgetAvailable();

  logger.action("Starting marketing engine", "start");
  const scheduledPins = await schedulePinsForNewListings();
  const publishedPins = await publishDuePins();
  const emailDrafts = await draftWeeklyEmailCampaign();

  const summary: MarketingEngineSummary = {
    scheduledPins,
    publishedPins,
    emailDrafts,
    failures: [],
  };
  logger.action("Completed marketing engine", "success", summary);
  return summary;
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone marketing-engine entry point and prints the run summary as JSON.
 */
async function main(): Promise<void> {
  try {
    const summary = await runMarketingEngine();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone marketing-engine execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
