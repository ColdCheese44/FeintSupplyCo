import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getListingsFlaggedForManualReview, getNicheById, getPublishedListings, initializeDatabase, insertAnalyticsSnapshot, markListingEtsyMissing } from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import { getListingMetrics } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface PerformanceSummary {
  listingId: number;
  title: string;
  niche: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
  conversionRate: number;
}

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedPayload {
  username: string;
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: DiscordEmbedField[];
    timestamp: string;
  }>;
}

export interface EtsyAnalyticsOptions {
  previewData?: PerformanceSummary[];
  previewFlaggedReviewItems?: string[];
  postToDiscord?: boolean;
  previewLabel?: string;
}

const logger = createLogger("etsy-analytics");

/**
 * Converts raw sales and traffic numbers into an easy-to-compare conversion percentage.
 */
function calculateConversionRate(sales: number, views: number): number {
  if (views <= 0) {
    return 0;
  }
  return (sales / views) * 100;
}

/**
 * Formats a performer list into the compact text Discord embed fields expect.
 */
function formatTopPerformers(performanceRows: PerformanceSummary[]): string {
  if (performanceRows.length === 0) {
    return "No published listings yet.";
  }

  return performanceRows
    .slice(0, 3)
    .map(
      (row, index) =>
        `${index + 1}. ${row.title} | $${row.revenue.toFixed(2)} revenue | ${row.conversionRate.toFixed(2)}% conversion`,
    )
    .join("\n");
}

/**
 * Builds a short recommendation string from the current analytics snapshot.
 */
function buildRecommendations(performanceRows: PerformanceSummary[]): string {
  if (performanceRows.length === 0) {
    return "Publish your first listing to start collecting Etsy performance data.";
  }

  const bestPerformer = performanceRows[0];
  if (bestPerformer.conversionRate >= 3) {
    return `Double down on ${bestPerformer.niche}; it currently leads on conversion and revenue.`;
  }

  return "Traffic is present but conversion is still modest. Test stronger thumbnails, tighter tag variants, or adjusted pricing.";
}

/**
 * Formats listings that require operator review so rights-sensitive trends stay visible but separated from normal performance.
 */
function formatFlaggedForReview(items: string[]): string {
  if (items.length === 0) {
    return "None.";
  }

  return items.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/**
 * Posts the analytics payload to the analytics Discord channel (falling back to the shared webhook).
 */
async function postDiscordWebhook(payload: DiscordEmbedPayload): Promise<void> {
  await postDiscord("analytics", payload as unknown as Record<string, unknown>);
}

/**
 * Builds the final analytics embed payload from normalized listing performance rows.
 */
export function buildEtsyAnalyticsPayload(
  performanceRows: PerformanceSummary[],
  options: { preview?: boolean; previewLabel?: string; flaggedForReview?: string[] } = {},
): DiscordEmbedPayload {
  const totalRevenue = performanceRows.reduce((sum, row) => sum + row.revenue, 0);
  const totalViews = performanceRows.reduce((sum, row) => sum + row.views, 0);
  const totalFavorites = performanceRows.reduce((sum, row) => sum + row.favorites, 0);
  const totalSales = performanceRows.reduce((sum, row) => sum + row.sales, 0);
  const previewLabel = options.previewLabel?.trim() || "PREVIEW - Not Live Data";

  return {
    username: "Jarvis",
    embeds: [
      {
        title: options.preview ? `Jarvis Etsy Performance Snapshot (${previewLabel})` : "Jarvis Etsy Performance Snapshot",
        description: options.preview
          ? "Synthetic preview of the daily Etsy analytics digest."
          : "Automated performance report for your published Etsy listings.",
        color: options.preview ? 0xffb000 : 0x00a86b,
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: "Store Totals",
            value: `Revenue: $${totalRevenue.toFixed(2)}\nViews: ${totalViews}\nFavorites: ${totalFavorites}\nSales: ${totalSales}`,
            inline: true,
          },
          {
            name: "Top Performers",
            value: formatTopPerformers(performanceRows),
            inline: false,
          },
          {
            name: "Recommendation",
            value: buildRecommendations(performanceRows),
            inline: false,
          },
          {
            name: "Flagged for Manual Review",
            value: formatFlaggedForReview(options.flaggedForReview ?? []),
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * Returns the dry-run analytics payload used when live Etsy reads are intentionally disabled.
 */
function buildDryRunAnalyticsPayload(): DiscordEmbedPayload {
  return {
    username: "Jarvis",
    embeds: [
      {
        title: "Jarvis Etsy Performance Snapshot",
        description: "Dry-run analytics payload generated without Etsy or Discord writes.",
        color: 0x808080,
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: "Store Totals",
            value: "Revenue: $0.00\nViews: 0\nFavorites: 0\nSales: 0",
            inline: true,
          },
          {
            name: "Top Performers",
            value: "Dry-run only. No live Etsy metrics were requested.",
            inline: false,
          },
          {
            name: "Recommendation",
            value: "Fill Etsy credentials, then rerun analytics live.",
            inline: false,
          },
          {
            name: "Flagged for Manual Review",
            value: "Dry-run only. No flagged live listings were inspected.",
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * Extracts recently flagged manual-review listings into compact digest rows.
 */
function collectFlaggedManualReviewItems(limit = 5): string[] {
  initializeDatabase();
  return getListingsFlaggedForManualReview(limit).map((listing) => {
    let reason = "Manual review required.";
    if (listing.metadata) {
      try {
        const parsed = JSON.parse(listing.metadata) as {
          manualReviewReason?: string;
          manual_review_reason?: string;
        };
        reason = parsed.manualReviewReason ?? parsed.manual_review_reason ?? reason;
      } catch {
        reason = "Manual review required.";
      }
    }

    return `${listing.title} (${listing.status}) — ${reason}`;
  });
}

/**
 * Collects fresh Etsy metrics, stores them in SQLite, and returns normalized rows for reporting.
 */
async function collectLivePerformanceRows(): Promise<PerformanceSummary[]> {
  initializeDatabase();
  const publishedListings = getPublishedListings();
  logger.action("Running Etsy analytics refresh", "start", { publishedListings: publishedListings.length });

  const performanceRows: PerformanceSummary[] = [];

  for (const listing of publishedListings) {
    if (!listing.etsy_listing_id) {
      logger.action("Skipping published listing with missing Etsy ID", "skip", { listingId: listing.id });
      continue;
    }

    try {
      const metrics = await getListingMetrics(listing.etsy_listing_id);
      insertAnalyticsSnapshot({
        listingId: listing.id,
        etsyListingId: listing.etsy_listing_id,
        views: metrics.views,
        favorites: metrics.favorites,
        sales: metrics.sales,
        revenue: metrics.revenue,
      });

      performanceRows.push({
        listingId: listing.id,
        title: listing.title,
        niche: getNicheById(listing.niche_id)?.name ?? "Unknown niche",
        views: metrics.views,
        favorites: metrics.favorites,
        sales: metrics.sales,
        revenue: metrics.revenue,
        conversionRate: calculateConversionRate(metrics.sales, metrics.views),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        markListingEtsyMissing(listing.id);
        logger.action("Marked listing as failed; Etsy returned 404 (listing no longer exists)", "skip", {
          listingId: listing.id,
          etsyListingId: listing.etsy_listing_id,
        });
      } else {
        logger.error("Failed to refresh metrics for a published listing", error, { listingId: listing.id });
      }
    }
  }

  performanceRows.sort((left, right) => right.revenue - left.revenue || right.conversionRate - left.conversionRate);
  return performanceRows;
}

/**
 * Collects analytics in live or preview mode and returns a Discord-ready summary payload.
 */
export async function runEtsyAnalytics(options: EtsyAnalyticsOptions = {}): Promise<DiscordEmbedPayload> {
  if (options.previewData) {
    const payload = buildEtsyAnalyticsPayload(options.previewData, {
      preview: true,
      previewLabel: options.previewLabel,
      flaggedForReview: options.previewFlaggedReviewItems ?? [],
    });
    logger.action("Preview Etsy analytics payload generated", "success", {
      rows: options.previewData.length,
      posted: options.postToDiscord === true,
    });
    if (options.postToDiscord) {
      await postDiscordWebhook(payload);
    }
    return payload;
  }

  if (isDryRunEnabled()) {
    const payload = buildDryRunAnalyticsPayload();
    logger.action("Dry-run Etsy analytics completed", "skip", { embeds: payload.embeds.length });
    return payload;
  }

  const performanceRows = await collectLivePerformanceRows();
  const payload = buildEtsyAnalyticsPayload(performanceRows, {
    flaggedForReview: collectFlaggedManualReviewItems(),
  });
  const shouldPost = options.postToDiscord ?? true;

  if (shouldPost) {
    await postDiscordWebhook(payload);
  }

  logger.action("Etsy analytics payload generated", "success", {
    publishedListings: performanceRows.length,
    totalRevenue: performanceRows.reduce((sum, row) => sum + row.revenue, 0),
    posted: shouldPost,
  });
  return payload;
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone analytics entry point and prints the Discord payload as JSON.
 */
async function main(): Promise<void> {
  try {
    const payload = await runEtsyAnalytics();
    console.log(JSON.stringify(payload, null, 2));
  } catch (error) {
    logger.error("Standalone analytics execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
