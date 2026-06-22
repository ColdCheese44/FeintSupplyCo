import "dotenv/config";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  getActiveNiches,
  getConsecutiveLowMarginOrderCount,
  getDatabase,
  getPublishedListings,
  getAutomationControl,
  initializeDatabase,
  isPublishingPaused,
  markListingPaused,
  pausePublishing,
  recordHeartbeatLog,
  resolveProjectPath,
  setAutomationControl,
  updateListingStatus,
  type NicheRecord,
} from "../lib/db.js";
import { updateListingSection } from "../lib/etsy-client.js";
import { writeHeartbeatTimestamp } from "../lib/heartbeat-state.js";
import { createLogger } from "../lib/logger.js";
import {
  HEARTBEAT_ROTATION_PRODUCT_TYPES,
  normalizeProductTypeList,
  type ProductType,
} from "../lib/product-types.js";
import { runShopSetup } from "../scripts/shop-setup.js";
import { runBalanceMonitor } from "./balance-monitor.js";
import { getBudgetSnapshot, runBudgetManager } from "./budget-manager.js";
import { runEtsyAnalytics } from "./etsy-analytics.js";
import { publishListing } from "./etsy-publish.js";
import { runCostDashboard } from "./cost-dashboard.js";
import { generateDesignBundle } from "./design-generator.js";
import { postDiscord, postDiscordText } from "../lib/discord.js";
import { runIgmMonitor } from "./igm-monitor.js";
import { generateListing, refreshLowViewListingTags } from "./listing-gen.js";
import { runMarketingEngine } from "./marketing-engine.js";
import { publishPodProduct } from "./pod-publisher.js";
import { runTrendMiner } from "./trend-miner.js";

interface JarvisRunSummary {
  startedAt: string;
  finishedAt: string;
  configuredResearchIntervalMinutes: number;
  configuredPublishIntervalHours: number;
  configuredMaxListingsPerDay: number;
  dailyListingLimitRemaining: number;
  opportunitiesConsidered: number;
  designsGenerated: number[];
  listingsGenerated: number[];
  productsPublished: Array<{ listingId: number; provider: "printify" | "printful" | "etsy"; providerProductId?: string; etsyListingId?: string }>;
  skippedItems: Array<{ key: string; reasons: string[] }>;
  failures: string[];
  analyticsPosted: boolean;
  marketingRun: boolean;
  igmStatus?: string;
  costReportPath?: string;
  heartbeatUpdatedAt?: string;
  totalClaudeCalls: number;
  claudeCallsByListing: Array<{ listingId: number; claudeCalls: number }>;
  totalCostUsd: number;
  pendingApprovalCount: number;
}

const logger = createLogger("fsc-loop");
const shopSetupLogPath = resolveProjectPath("data/shop/setup-log.json");
const heartbeatProductRotation = [...HEARTBEAT_ROTATION_PRODUCT_TYPES];

/**
 * Reads a positive integer from the environment while preserving a safe fallback.
 */
function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Chooses a product type for a mined theme so the pipeline can cover multiple POD categories over time.
 */
function chooseProductType(theme: string, index: number, niche: NicheRecord, rotationCursor: number): ProductType {
  const normalized = theme.toLowerCase();
  if (normalized.includes("poster") || normalized.includes("wall art")) {
    return "poster";
  }
  if (normalized.includes("sticker")) {
    return "sticker";
  }
  if (normalized.includes("mug") || normalized.includes("coffee")) {
    return "mug";
  }
  if (normalized.includes("hoodie") || normalized.includes("sweatshirt")) {
    return "hoodie";
  }
  if (normalized.includes("pin") || normalized.includes("badge")) {
    return "enamel-pin";
  }
  if (normalized.includes("shirt") || normalized.includes("tee")) {
    return "t-shirt";
  }

  const nicheRotation = normalizeProductTypeList(niche.product_types)
    .filter((productType): productType is (typeof heartbeatProductRotation)[number] =>
      productType !== "enamel-pin" && heartbeatProductRotation.includes(productType),
    );
  const rotation = nicheRotation.length > 0 ? nicheRotation : heartbeatProductRotation;
  return rotation[(rotationCursor + index) % rotation.length];
}

/**
 * Chooses the best-fit active niche for a trend theme using simple keyword overlap, with a stable fallback order.
 */
function chooseNicheForOpportunity(theme: string, index: number, activeNiches: NicheRecord[]): NicheRecord {
  if (activeNiches.length === 0) {
    throw new Error("No active niches are available for heartbeat listing generation.");
  }

  const normalizedTheme = theme.toLowerCase();
  const scored = activeNiches
    .map((niche) => {
      const tokens = niche.name.toLowerCase().split(/\s+/).filter((token) => token.length >= 4);
      const score = tokens.reduce((sum, token) => sum + (normalizedTheme.includes(token) ? 1 : 0), 0);
      return { niche, score };
    })
    .sort((left, right) => right.score - left.score || left.niche.priority - right.niche.priority);

  return scored[0]?.score > 0 ? scored[0].niche : activeNiches[index % activeNiches.length];
}

/**
 * Reads the persisted product-type rotation cursor so heartbeat runs do not always start from the same item class.
 */
function readProductRotationCursor(): number {
  const rawValue = getAutomationControl("product_type_rotation_cursor")?.value ?? "0";
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed % heartbeatProductRotation.length : 0;
}

/**
 * Returns whether new listings should be held for manual approval instead of auto-publishing.
 */
function requiresApproval(): boolean {
  return (process.env.REQUIRE_APPROVAL ?? "").trim().toLowerCase() === "true";
}

/**
 * Stops new publishing before a heartbeat run starts when margin safety rails have already tripped.
 */
function enforceGlobalSafetyRails(): void {
  if (getConsecutiveLowMarginOrderCount(0.15, 5) >= 5) {
    pausePublishing("Publishing auto-paused after five consecutive low-margin orders.");
  }
}

/**
 * Posts a simple Discord alert when autonomous guardrails need to surface an operator action.
 */
async function postDiscordMessage(message: string): Promise<void> {
  await postDiscordText("heartbeat", message);
}

/**
 * Applies the pre-run balance and budget guardrails that decide whether new image generation and publishing should continue.
 */
async function evaluatePreRunGuardrails(): Promise<{
  skipImageGeneration: boolean;
}> {
  const balance = await runBalanceMonitor();
  let skipImageGeneration = false;
  const hasOpenAiImageFallback = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (balance.replicate.status === "low" && !hasOpenAiImageFallback) {
    skipImageGeneration = true;
    if (getAutomationControl("replicate_low_credit_notice")?.value !== "sent") {
      await postDiscordMessage(
        "LOW REPLICATE CREDIT - image gen paused. Add credits at https://replicate.com/account/billing",
      );
      setAutomationControl("replicate_low_credit_notice", "sent", "Low Replicate credit paused new heartbeat image generation.");
    }
  } else if (balance.replicate.status === "low") {
    setAutomationControl(
      "replicate_low_credit_notice",
      "fallback",
      "Replicate credit is low; OpenAI image generation remains available as the automatic fallback.",
    );
  } else {
    setAutomationControl("replicate_low_credit_notice", "clear", "Replicate credit is healthy again.");
  }

  const snapshot = getBudgetSnapshot();
  const spendRatio = snapshot.seedBudgetUsd > 0 ? snapshot.totalSpentUsd / snapshot.seedBudgetUsd : 1;
  if (spendRatio >= 0.90) {
    pausePublishing("Budget warning: 90% of seed budget used.");
    if (getAutomationControl("budget_90_percent_warning")?.value !== "sent") {
      await postDiscordMessage(
        "BUDGET WARNING: 90% of seed budget used. Add funds or increase budget in .env to continue.",
      );
      setAutomationControl("budget_90_percent_warning", "sent", "Budget exceeded 90% of the configured seed budget.");
    }
  } else {
    setAutomationControl("budget_90_percent_warning", "clear", "Budget returned below the 90% warning threshold.");
  }

  return { skipImageGeneration };
}

/**
 * Posts one weekly revenue summary after reinvestment has been recorded so the operator sees money flow without reading the ledger directly.
 */
async function maybePostWeeklyRevenueSummary(): Promise<void> {
  const now = new Date();
  if (now.getUTCDay() !== 0) {
    return;
  }

  const weekKey = `${now.getUTCFullYear()}-W${Math.ceil((((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7)}`;
  if (getAutomationControl("weekly_revenue_summary_week")?.value === weekKey) {
    return;
  }

  const db = getDatabase();
  const revenue = Number((db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total
    FROM orders
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { total: number }).total ?? 0);
  const orderCount = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM orders
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { count: number }).count ?? 0);
  const reinvestment = Number((db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM budget_ledger
    WHERE category IN ('reserve', 'scale_winners', 'explore_new', 'quality_upgrade', 'etsy_ads', 'trademark_reserve', 'platform_expansion_reserve')
      AND timestamp >= datetime('now', '-7 days')
  `).get() as { total: number }).total ?? 0);
  const earnings = Number((db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM budget_ledger
    WHERE category = 'operator_earnings'
      AND timestamp >= datetime('now', '-7 days')
  `).get() as { total: number }).total ?? 0);

  await postDiscordMessage(
    `WEEKLY REPORT:\nRevenue: $${revenue.toFixed(2)}\nReinvestment: $${reinvestment.toFixed(2)} (40%)\nYour earnings: $${earnings.toFixed(2)} (60%)\nActive listings: ${getPublishedListings().length}\nOrders this week: ${orderCount}`,
  );
  setAutomationControl("weekly_revenue_summary_week", weekKey, "Weekly revenue summary delivered.");
}

/**
 * Returns whether the local storefront setup log already marks shop setup complete.
 */
async function isShopSetupComplete(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(shopSetupLogPath, "utf8")) as { setup_complete?: boolean };
    return parsed.setup_complete === true;
  } catch {
    return false;
  }
}

/**
 * Returns whether the current heartbeat is the first run of a new month for storefront announcement refreshes.
 */
async function shouldRefreshShopAnnouncement(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(shopSetupLogPath, "utf8")) as { last_refresh_at?: string };
    const lastRefresh = parsed.last_refresh_at ? new Date(parsed.last_refresh_at) : null;
    const now = new Date();
    return !lastRefresh || lastRefresh.getUTCFullYear() !== now.getUTCFullYear() || lastRefresh.getUTCMonth() !== now.getUTCMonth();
  } catch {
    return true;
  }
}

/**
 * Assigns stored Etsy section IDs to any published listings that have a suggested section but no recorded assignment yet.
 */
async function assignMissingListingSections(): Promise<number> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT id, etsy_listing_id, metadata
    FROM listings
    WHERE etsy_listing_id IS NOT NULL
      AND metadata IS NOT NULL
  `).all() as Array<{ id: number; etsy_listing_id: string; metadata: string }>;

  let assigned = 0;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata) as {
        suggestedShopSectionId?: string | null;
        assignedShopSectionId?: string | null;
      };

      if (!metadata.suggestedShopSectionId || metadata.assignedShopSectionId === metadata.suggestedShopSectionId) {
        continue;
      }

      await updateListingSection(row.etsy_listing_id, metadata.suggestedShopSectionId);
      db.prepare(`
        UPDATE listings
        SET metadata = ?
        WHERE id = ?
      `).run(JSON.stringify({
        ...metadata,
        assignedShopSectionId: metadata.suggestedShopSectionId,
      }), row.id);
      assigned += 1;
    } catch (error) {
      logger.error("Failed to assign Etsy listing section automatically", error, { listingId: row.id });
    }
  }

  return assigned;
}

/**
 * Runs one full Phase 2 FeintSupplyCo heartbeat cycle and returns a structured summary of the work completed.
 */
export async function runHeartbeatLoop(): Promise<JarvisRunSummary> {
  initializeDatabase();
  enforceGlobalSafetyRails();

  const researchIntervalMinutes = readPositiveInteger(process.env.RESEARCH_INTERVAL_MINUTES, 60);
  const publishIntervalHours = readPositiveInteger(process.env.PUBLISH_INTERVAL_HOURS, 6);
  const maxListingsPerRun = readPositiveInteger(process.env.MAX_LISTINGS_PER_RUN, 3);
  const maxListingsPerDay = readPositiveInteger(process.env.MAX_LISTINGS_PER_DAY, 5);
  const listingsCreatedToday = Number((getDatabase().prepare(`
    SELECT COUNT(*) AS count
    FROM listings
    WHERE datetime(created_at) >= datetime('now', 'start of day')
  `).get() as { count: number }).count ?? 0);
  const dailyListingLimitRemaining = Math.max(0, maxListingsPerDay - listingsCreatedToday);
  const listingCapacityThisRun = Math.min(maxListingsPerRun, dailyListingLimitRemaining);

  const summary: JarvisRunSummary = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    configuredResearchIntervalMinutes: researchIntervalMinutes,
    configuredPublishIntervalHours: publishIntervalHours,
    configuredMaxListingsPerDay: maxListingsPerDay,
    dailyListingLimitRemaining,
    opportunitiesConsidered: 0,
    designsGenerated: [],
    listingsGenerated: [],
    productsPublished: [],
    skippedItems: [],
    failures: [],
    analyticsPosted: false,
    marketingRun: false,
    totalClaudeCalls: 0,
    claudeCallsByListing: [],
    totalCostUsd: 0,
    pendingApprovalCount: 0,
  };
  let heartbeatShouldUpdate = false;

  logger.action("Starting FeintSupplyCo heartbeat run", "start", {
    researchIntervalMinutes,
    publishIntervalHours,
    maxListingsPerRun,
    maxListingsPerDay,
    dailyListingLimitRemaining,
    publishingPaused: isPublishingPaused(),
  });

  try {
    const guardrails = await evaluatePreRunGuardrails();
    const activeNiches = getActiveNiches();
    const rotationCursor = readProductRotationCursor();

    if ((process.env.DRY_RUN ?? "").trim().toLowerCase() === "false" && !(await isShopSetupComplete())) {
      await runShopSetup();
    }

    if ((process.env.DRY_RUN ?? "").trim().toLowerCase() === "false" && await shouldRefreshShopAnnouncement()) {
      await runShopSetup({ refreshOnly: true });
    }

    const opportunities = await runTrendMiner(maxListingsPerRun);
    summary.opportunitiesConsidered = opportunities.length;
    const actionableOpportunities = opportunities.slice(0, listingCapacityThisRun);

    if (listingCapacityThisRun === 0) {
      summary.skippedItems.push({
        key: "daily-listing-limit",
        reasons: [`Daily listing limit reached (${listingsCreatedToday}/${maxListingsPerDay}). Research and maintenance tasks still ran.`],
      });
    }

    if (guardrails.skipImageGeneration) {
      for (const opportunity of actionableOpportunities) {
        summary.skippedItems.push({
          key: `theme-${opportunity.theme}`,
          reasons: ["Low Replicate credit - image generation paused for this heartbeat."],
        });
      }
    }

    for (const [index, opportunity] of actionableOpportunities.entries()) {
      if (guardrails.skipImageGeneration) {
        continue;
      }

      try {
        const niche = chooseNicheForOpportunity(opportunity.theme, index, activeNiches);
        const productType = chooseProductType(opportunity.theme, index, niche, rotationCursor);
        const design = await generateDesignBundle({
          theme: opportunity.theme,
          productType,
          requiresManualReview: opportunity.realPersonFlag,
          manualReviewReason: opportunity.realPersonFlag ? "REAL PERSON FLAG: Verify merchandise rights before publishing" : null,
        });
        summary.designsGenerated.push(design.id);

        const listing = await generateListing({
          nicheId: niche.id,
          keyword: opportunity.theme,
          designId: design.id,
          productType,
        });
        summary.listingsGenerated.push(listing.id);
        try {
          const metadata = listing.metadata ? (JSON.parse(listing.metadata) as { claudeCallCount?: number }) : {};
          const claudeCalls = Number(metadata.claudeCallCount ?? 0);
          summary.totalClaudeCalls += claudeCalls;
          summary.claudeCallsByListing.push({ listingId: listing.id, claudeCalls });
        } catch {
          summary.claudeCallsByListing.push({ listingId: listing.id, claudeCalls: 0 });
        }

        if (opportunity.realPersonFlag) {
          markListingPaused(listing.id, {
            realPersonFlag: true,
            requiresManualReview: true,
            manualReviewReason: "REAL PERSON FLAG: Verify merchandise rights before publishing",
          });
          summary.skippedItems.push({
            key: `listing-${listing.id}`,
            reasons: ["REAL PERSON FLAG: Verify merchandise rights before publishing"],
          });
          continue;
        }

        if (requiresApproval() || productType === "enamel-pin") {
          const approvalReason = productType === "enamel-pin"
            ? "Enamel pins use the Etsy-only made-to-order approval flow."
            : "Held for manual approval before publishing.";
          updateListingStatus(listing.id, "pending_approval", {
            ...(listing.metadata ? JSON.parse(listing.metadata) as Record<string, unknown> : {}),
            localDesignPath: design.image_path,
            theme: opportunity.theme,
            approvalHeld: true,
            approvalReason,
          });
          summary.pendingApprovalCount += 1;
          logger.info(`Listing held for approval: ${listing.title}`, {
            listingId: listing.id,
            theme: opportunity.theme,
            productType,
          });
          summary.skippedItems.push({
            key: `listing-${listing.id}`,
            reasons: [approvalReason],
          });
          continue;
        }

        if (isPublishingPaused()) {
          summary.skippedItems.push({
            key: `listing-${listing.id}`,
            reasons: ["Publishing is currently paused by a safety rail."],
          });
          continue;
        }

        const publishResult = await publishPodProduct(listing.id);
        if (publishResult.success) {
          let etsyListingId = publishResult.etsyListingId;
          if (!etsyListingId) {
            const etsyPublishResult = await publishListing(listing.id);
            if (!etsyPublishResult.success || !etsyPublishResult.etsy_listing_id) {
              throw new Error(etsyPublishResult.error ?? `Listing ${listing.id} failed to publish to Etsy after POD creation.`);
            }
            etsyListingId = etsyPublishResult.etsy_listing_id;
          }

          const provider = publishResult.printifyProductId
            ? "printify"
            : publishResult.printfulProductId
              ? "printful"
              : "etsy";
          const providerProductId = publishResult.printifyProductId ?? publishResult.printfulProductId;
          summary.productsPublished.push({
            listingId: listing.id,
            provider,
            providerProductId,
            etsyListingId,
          });
          if (publishResult.warning) {
            summary.skippedItems.push({
              key: `listing-${listing.id}`,
              reasons: [publishResult.warning],
            });
          }
        } else {
          summary.failures.push(`Listing ${listing.id} failed to publish through POD: ${publishResult.error ?? "Unknown error"}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.failures.push(message);
        logger.error("FeintSupplyCo pipeline failed for one mined opportunity", error, { opportunity });
      }
    }

    setAutomationControl(
      "product_type_rotation_cursor",
      String((rotationCursor + actionableOpportunities.length) % heartbeatProductRotation.length),
      "Heartbeat product-type rotation advanced after the current run.",
    );

    await runMarketingEngine();
    summary.marketingRun = true;
    await assignMissingListingSections();
    await refreshLowViewListingTags();
    await runEtsyAnalytics();
    summary.analyticsPosted = Boolean(process.env.DISCORD_WEBHOOK_URL?.trim());
    try {
      const igmEnabled = ["true", "1", "yes"].includes(process.env.IGM_ENABLED?.trim().toLowerCase() ?? "");
      const igmResult = await runIgmMonitor({
        postToDiscord: igmEnabled && Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
      });
      summary.igmStatus = igmResult.status.status;
    } catch (error) {
      summary.failures.push(`IGM monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const costResult = await runCostDashboard();
    summary.costReportPath = costResult.reportPath;
    summary.totalCostUsd = Number(costResult.snapshot.today.total.toFixed(2));
    await runBudgetManager();
    await maybePostWeeklyRevenueSummary();
    summary.heartbeatUpdatedAt = await writeHeartbeatTimestamp();
    setAutomationControl("system_stale", "false", "Heartbeat completed successfully.");
    heartbeatShouldUpdate = true;
  } finally {
    if (!heartbeatShouldUpdate) {
      logger.warn("Heartbeat timestamp was not updated because the heartbeat did not complete cleanly.");
    }
    summary.finishedAt = new Date().toISOString();
    try {
      recordHeartbeatLog({
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        opportunitiesConsidered: summary.opportunitiesConsidered,
        designsGenerated: summary.designsGenerated.length,
        listingsPublished: summary.productsPublished.length,
        totalCostUsd: summary.totalCostUsd,
        errorCount: summary.failures.length,
        errors: summary.failures,
        claudeCalls: summary.totalClaudeCalls,
      });
    } catch (error) {
      logger.error("Failed to record heartbeat log row", error, {
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
      });
    }
    logger.action("Completed FeintSupplyCo heartbeat run", "success", summary);

    try {
      const reportEnabled = (process.env.HEARTBEAT_DISCORD_REPORT?.trim().toLowerCase() ?? "true") !== "false";
      if (reportEnabled) {
        const failed = summary.failures.length > 0;
        await postDiscord("heartbeat", {
          embeds: [
            {
              title: failed ? "Heartbeat complete — with issues" : "Heartbeat complete",
              description: `Cycle ran ${summary.startedAt} → ${summary.finishedAt}.`,
              color: failed ? 0xffb000 : 0x10a37f,
              timestamp: summary.finishedAt,
              fields: [
                { name: "Opportunities", value: String(summary.opportunitiesConsidered), inline: true },
                { name: "Designs", value: String(summary.designsGenerated.length), inline: true },
                { name: "Listings", value: String(summary.listingsGenerated.length), inline: true },
                { name: "Published", value: String(summary.productsPublished.length), inline: true },
                { name: "Pending approval", value: String(summary.pendingApprovalCount), inline: true },
                { name: "Today's cost", value: `$${summary.totalCostUsd.toFixed(2)}`, inline: true },
                {
                  name: "Failures",
                  value: summary.failures.length ? summary.failures.slice(0, 3).join("\n").slice(0, 1000) : "None",
                  inline: false,
                },
              ],
            },
          ],
        });
      }
    } catch (error) {
      logger.warn("Failed to post heartbeat summary to Discord", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone FeintSupplyCo loop entry point and prints the run summary as JSON.
 */
async function main(): Promise<void> {
  try {
    const summary = await runHeartbeatLoop();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone FeintSupplyCo loop execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
