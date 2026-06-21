import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  clearPublishingPause,
  getAutomationControl,
  getBudgetLedgerTotal,
  getDatabase,
  getRecentBudgetLedgerEntries,
  initializeDatabase,
  pausePublishing,
  recordBudgetLedgerEntry,
  setAutomationControl,
} from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import { createLogger } from "../lib/logger.js";
import { allocateReinvestment, type ReinvestmentAllocationSummary, type ReinvestmentListingPerformance, type ReinvestmentNichePerformance } from "../lib/reinvestment-allocator.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export type BudgetCategory =
  | "listing_fee"
  | "image_gen"
  | "llm_copy"
  | "marketing"
  | "reserve"
  | "operator_earnings"
  | "scale_winners"
  | "explore_new"
  | "quality_upgrade"
  | "etsy_ads"
  | "trademark_reserve"
  | "platform_expansion_reserve";

export interface BudgetAuthorizationResult {
  approved: boolean;
  category: BudgetCategory;
  amountUsd: number;
  reason: string;
  remainingCategoryBudgetUsd: number;
  remainingTotalBudgetUsd: number;
}

export interface BudgetSnapshot {
  seedBudgetUsd: number;
  totalSpentUsd: number;
  reinvestedUsd: number;
  operatorEarningsUsd: number;
  grossRevenueUsd: number;
  netProfitUsd: number;
  remainingBudgetUsd: number;
  availableBudgetUsd: number;
  categorySpent: Record<string, number>;
  categoryCaps: Record<string, number>;
}

export interface ReinvestmentCalculation {
  grossRevenue: number;
  etsyFeesPaid: number;
  podCosts: number;
  apiCosts: number;
  netProfit: number;
  reinvestAmount: number;
  operatorEarnings: number;
}

const logger = createLogger("budget-manager");

/**
 * Reads a numeric env value while preserving a safe default.
 */
function readNumber(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Returns the configured seed budget and reinvestment policy in one place.
 */
function readBudgetConfig(): {
  seedBudgetUsd: number;
  reinvestPercent: number;
  categoryAllocations: Record<Extract<BudgetCategory, "listing_fee" | "image_gen" | "llm_copy" | "marketing" | "reserve">, number>;
} {
  return {
    seedBudgetUsd: readNumber("SEED_BUDGET_USD", 100),
    reinvestPercent: readNumber("BUDGET_REINVEST_PERCENT", 0.4),
    categoryAllocations: {
      listing_fee: readNumber("BUDGET_LISTING_FEES_ALLOCATION", 0.3),
      image_gen: readNumber("BUDGET_IMAGE_GEN_ALLOCATION", 0.2),
      llm_copy: readNumber("BUDGET_LLM_COPY_ALLOCATION", 0.15),
      marketing: readNumber("BUDGET_MARKETING_ALLOCATION", 0.15),
      reserve: readNumber("BUDGET_RESERVE_ALLOCATION", 0.2),
    },
  };
}

/**
 * Posts a one-time Discord alert keyed by a persistent automation-control flag.
 */
async function postBudgetAlertOnce(key: string, message: string): Promise<void> {
  if (getAutomationControl(key)?.value === "sent") {
    return;
  }

  await postDiscord("cost", {
    embeds: [
      {
        title: "Jarvis Budget Alert",
        description: message,
        color: 0xffb000,
        timestamp: new Date().toISOString(),
      },
    ],
  });

  setAutomationControl(key, "sent", message);
}

/**
 * Builds a live budget snapshot from the ledger plus order profitability.
 */
export function getBudgetSnapshot(): BudgetSnapshot {
  initializeDatabase();
  const db = getDatabase();
  const { seedBudgetUsd, categoryAllocations } = readBudgetConfig();

  const grossRevenue = Number((db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders`).get() as { total: number }).total ?? 0);
  const netProfit = Number((db.prepare(`SELECT COALESCE(SUM(profit_amount), 0) AS total FROM orders`).get() as { total: number }).total ?? 0);
  const totalSpentUsd = Number((db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM budget_ledger
    WHERE amount_usd > 0
      AND category != 'operator_earnings'
  `).get() as { total: number }).total ?? 0);
  const reinvestedUsd = Math.abs(getBudgetLedgerTotal("reserve")) + Math.abs(getBudgetLedgerTotal("scale_winners")) + Math.abs(getBudgetLedgerTotal("explore_new"))
    + Math.abs(getBudgetLedgerTotal("quality_upgrade")) + Math.abs(getBudgetLedgerTotal("etsy_ads"))
    + Math.abs(getBudgetLedgerTotal("trademark_reserve")) + Math.abs(getBudgetLedgerTotal("platform_expansion_reserve"));
  const operatorEarningsUsd = getBudgetLedgerTotal("operator_earnings");

  const categorySpent: Record<string, number> = {
    listing_fee: getBudgetLedgerTotal("listing_fee"),
    image_gen: getBudgetLedgerTotal("image_gen"),
    llm_copy: getBudgetLedgerTotal("llm_copy"),
    marketing: getBudgetLedgerTotal("marketing"),
    reserve: getBudgetLedgerTotal("reserve"),
  };
  const categoryCaps = Object.fromEntries(
    Object.entries(categoryAllocations).map(([key, ratio]) => [key, Number((seedBudgetUsd * ratio).toFixed(2))]),
  );

  const remainingBudgetUsd = Number(Math.max(seedBudgetUsd - totalSpentUsd, 0).toFixed(2));
  const availableBudgetUsd = Number(Math.max(seedBudgetUsd + reinvestedUsd - totalSpentUsd, 0).toFixed(2));

  return {
    seedBudgetUsd,
    totalSpentUsd: Number(totalSpentUsd.toFixed(2)),
    reinvestedUsd: Number(reinvestedUsd.toFixed(2)),
    operatorEarningsUsd: Number(operatorEarningsUsd.toFixed(2)),
    grossRevenueUsd: Number(grossRevenue.toFixed(2)),
    netProfitUsd: Number(netProfit.toFixed(2)),
    remainingBudgetUsd,
    availableBudgetUsd,
    categorySpent,
    categoryCaps,
  };
}

/**
 * Blocks or authorizes a spend operation based on category allocation and total available budget.
 */
export async function authorizeBudgetSpend(
  category: Extract<BudgetCategory, "listing_fee" | "image_gen" | "llm_copy" | "marketing">,
  amountUsd: number,
  operation: string,
  referenceId?: string | number,
): Promise<BudgetAuthorizationResult> {
  initializeDatabase();
  const snapshot = getBudgetSnapshot();
  const categoryCap = snapshot.categoryCaps[category] ?? 0;
  const categorySpent = snapshot.categorySpent[category] ?? 0;

  if (snapshot.availableBudgetUsd <= 0 || snapshot.totalSpentUsd >= snapshot.seedBudgetUsd + snapshot.reinvestedUsd) {
    const reason = "Total Jarvis budget is depleted.";
    recordBudgetLedgerEntry({
      category,
      amountUsd: 0,
      operation: `${operation}:skipped`,
      referenceId,
      metadata: { reason },
    });
    return {
      approved: false,
      category,
      amountUsd,
      reason,
      remainingCategoryBudgetUsd: Math.max(categoryCap - categorySpent, 0),
      remainingTotalBudgetUsd: snapshot.availableBudgetUsd,
    };
  }

  if (categorySpent + amountUsd > categoryCap) {
    const reason = `${category} allocation exceeded.`;
    recordBudgetLedgerEntry({
      category,
      amountUsd: 0,
      operation: `${operation}:skipped`,
      referenceId,
      metadata: { reason, categoryCap, categorySpent, attemptedAmountUsd: amountUsd },
    });
    await postBudgetAlertOnce(`budget_category_exhausted_${category}`, `${category} budget has been exhausted. Jarvis will skip new ${category} spending until budget is replenished.`);
    return {
      approved: false,
      category,
      amountUsd,
      reason,
      remainingCategoryBudgetUsd: Math.max(categoryCap - categorySpent, 0),
      remainingTotalBudgetUsd: snapshot.availableBudgetUsd,
    };
  }

  if (amountUsd > 0) {
    recordBudgetLedgerEntry({
      category,
      amountUsd,
      operation,
      referenceId,
    });
  }

  return {
    approved: true,
    category,
    amountUsd,
    reason: "Authorized",
    remainingCategoryBudgetUsd: Number(Math.max(categoryCap - categorySpent - amountUsd, 0).toFixed(2)),
    remainingTotalBudgetUsd: Number(Math.max(snapshot.availableBudgetUsd - amountUsd, 0).toFixed(2)),
  };
}

/**
 * Calculates reinvestment and operator earnings from gross revenue, POD costs, and ledgered platform/API spend.
 */
export function calculateReinvestment(): ReinvestmentCalculation {
  initializeDatabase();
  const db = getDatabase();
  const reinvestPercent = readBudgetConfig().reinvestPercent;

  const grossRevenue = Number((db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders`).get() as { total: number }).total ?? 0);
  const etsyFeesPaid = getBudgetLedgerTotal("listing_fee");
  const podCosts = Number((db.prepare(`SELECT COALESCE(SUM(MAX(total_amount - profit_amount, 0)), 0) AS total FROM orders`).get() as { total: number }).total ?? 0);
  const apiCosts = getBudgetLedgerTotal("image_gen") + getBudgetLedgerTotal("llm_copy") + getBudgetLedgerTotal("marketing");
  const netProfit = Number((grossRevenue - etsyFeesPaid - podCosts - apiCosts).toFixed(2));
  const reinvestAmount = Number(Math.max(netProfit, 0) * reinvestPercent).toFixed(2);
  const operatorEarnings = Number(Math.max(netProfit, 0) * (1 - reinvestPercent)).toFixed(2);

  return {
    grossRevenue: Number(grossRevenue.toFixed(2)),
    etsyFeesPaid: Number(etsyFeesPaid.toFixed(2)),
    podCosts: Number(podCosts.toFixed(2)),
    apiCosts: Number(apiCosts.toFixed(2)),
    netProfit,
    reinvestAmount: Number(reinvestAmount),
    operatorEarnings: Number(operatorEarnings),
  };
}

/**
 * Runs one reinvestment allocation cycle using live performance data and records the resulting bucket splits in the ledger.
 */
export async function runDailyReinvestmentCycle(): Promise<ReinvestmentAllocationSummary | null> {
  initializeDatabase();
  const calculation = calculateReinvestment();
  const lastDistributedNetProfit = Number(getAutomationControl("last_reinvestment_net_profit")?.value ?? "0");
  const incrementalNetProfit = Number((calculation.netProfit - lastDistributedNetProfit).toFixed(2));
  const minimumPool = readNumber("REINVESTMENT_MIN_POOL_USD", 0.5);
  if (incrementalNetProfit <= 0) {
    return null;
  }

  const reinvestPercent = readBudgetConfig().reinvestPercent;
  const incrementalReinvestAmount = Number((incrementalNetProfit * reinvestPercent).toFixed(2));
  const incrementalOperatorEarnings = Number((incrementalNetProfit * (1 - reinvestPercent)).toFixed(2));

  if (incrementalReinvestAmount < minimumPool) {
    return null;
  }

  const db = getDatabase();
  const nicheRows = db.prepare(`
    SELECT
      n.id AS nicheId,
      n.name AS niche,
      n.priority AS priority,
      n.active AS active,
      COALESCE(SUM(a.sales), 0) AS sales30d,
      COALESCE(SUM(a.revenue), 0) AS revenue30d,
      COALESCE(SUM(a.sales) * 1.0 / NULLIF(SUM(a.views), 0), 0) AS conversionRate,
      MAX(a.recorded_at) AS lastSaleAt
    FROM niches n
    LEFT JOIN listings l ON l.niche_id = n.id
    LEFT JOIN analytics a ON a.listing_id = l.id AND a.recorded_at >= datetime('now', '-30 days')
    GROUP BY n.id, n.name, n.priority, n.active
  `).all() as ReinvestmentNichePerformance[];

  const listingRows = db.prepare(`
    SELECT
      l.id AS listingId,
      l.title AS title,
      COALESCE(json_extract(l.metadata, '$.keyword'), l.title) AS theme,
      COALESCE(MAX(a.views), 0) AS views,
      COALESCE(MAX(a.sales) * 1.0 / NULLIF(MAX(a.views), 0), 0) AS conversionRate
    FROM listings l
    LEFT JOIN analytics a ON a.listing_id = l.id
    GROUP BY l.id, l.title, l.metadata
  `).all() as ReinvestmentListingPerformance[];

  const summary = allocateReinvestment({
    reinvestAmount: incrementalReinvestAmount,
    operatorEarnings: incrementalOperatorEarnings,
    niches: nicheRows,
    candidateListings: listingRows,
  });

  recordBudgetLedgerEntry({
    category: "operator_earnings",
    amountUsd: summary.operatorEarnings,
    operation: "daily_reinvestment_operator_earnings",
    metadata: { grossRevenue: calculation.grossRevenue, netProfit: calculation.netProfit },
  });

  for (const bucket of summary.buckets) {
    recordBudgetLedgerEntry({
      category: bucket.bucket.toLowerCase() as BudgetCategory,
      amountUsd: bucket.amountUsd,
      operation: "daily_reinvestment_allocation",
      metadata: { target: bucket.target ?? null, note: bucket.note },
    });
  }

  setAutomationControl(
    "last_reinvestment_net_profit",
    calculation.netProfit.toFixed(2),
    `Reinvestment distributed through net profit ${calculation.netProfit.toFixed(2)}.`,
  );

  return summary;
}

/**
 * Applies near-limit budget safety rails without stopping analytics or fulfillment work.
 */
export async function checkBudgetHealth(): Promise<BudgetSnapshot> {
  const snapshot = getBudgetSnapshot();
  const spendRatio = snapshot.seedBudgetUsd > 0 ? snapshot.totalSpentUsd / snapshot.seedBudgetUsd : 1;
  const publishingPause = getAutomationControl("publishing_paused");

  if (
    spendRatio < 1
    && publishingPause?.value === "true"
    && publishingPause.reason === "Seed budget depleted - awaiting first sale."
  ) {
    clearPublishingPause("Publishing resumed after correcting the available seed budget.");
  }

  if (spendRatio >= 0.95) {
    setAutomationControl("max_listings_override", "1", "Budget near limit - reinvestment only mode.");
    setAutomationControl("image_generation_mode", "cheapest_only", "Budget near limit - cheapest image route only.");
    await postBudgetAlertOnce("budget_near_limit", "Budget near limit - reinvestment only mode.");
  }

  if (spendRatio >= 1 && snapshot.grossRevenueUsd <= 0) {
    pausePublishing("Seed budget depleted - awaiting first sale.");
    await postBudgetAlertOnce("budget_seed_depleted", "Seed budget depleted - awaiting first sale.");
  }

  return snapshot;
}

/**
 * Builds the lightweight budget report object used by the heartbeat and dashboard layers.
 */
export async function runBudgetManager(): Promise<{ snapshot: BudgetSnapshot; reinvestment: ReinvestmentAllocationSummary | null }> {
  const snapshot = await checkBudgetHealth();
  const reinvestment = isDryRunEnabled() ? null : await runDailyReinvestmentCycle();
  logger.action("Budget manager completed", "success", {
    remainingBudgetUsd: snapshot.remainingBudgetUsd,
    availableBudgetUsd: snapshot.availableBudgetUsd,
    reinvestment: reinvestment?.reinvestAmount ?? 0,
  });
  return { snapshot, reinvestment };
}

/**
 * Runs the standalone budget-manager entry point and prints the most recent snapshot plus ledger tail.
 */
async function main(): Promise<void> {
  const result = await runBudgetManager();
  console.log(JSON.stringify({
    snapshot: result.snapshot,
    reinvestment: result.reinvestment,
    recentLedger: getRecentBudgetLedgerEntries(10),
  }, null, 2));
}

/**
 * Detects direct execution so the budget manager can run standalone for diagnostics.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  await main();
}
