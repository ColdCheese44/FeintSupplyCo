import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getDatabase, initializeDatabase, resolveProjectPath } from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import { createLogger } from "../lib/logger.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { renderTextTable } from "../lib/text-table.js";

export interface CostBreakdown {
  llm: number;
  imageGen: number;
  marketing: number;
  pod: number;
  total: number;
}

export interface CostDashboardOperation {
  category: string;
  label: string;
  costUsd: number;
  occurredAt: string;
}

export interface CostDashboardSnapshot {
  generatedAt: string;
  today: CostBreakdown;
  sevenDay: CostBreakdown;
  todayProfit: number;
  sevenDayProfit: number;
  budgets: {
    dailyDesignBudgetUsd: number;
    weeklyAdBudgetUsd: number;
  };
  ratios: {
    todayProfitToSpend: number;
    sevenDayProfitToSpend: number;
  };
  topOperations: CostDashboardOperation[];
}

export interface CostDashboardResult {
  snapshot: CostDashboardSnapshot;
  table: string;
  reportPath: string;
  embed: {
    username: string;
    embeds: Array<{
      title: string;
      description: string;
      color: number;
      fields: Array<{ name: string; value: string; inline?: boolean }>;
      timestamp: string;
    }>;
  };
}

export interface CostDashboardOptions {
  preview?: boolean;
  syntheticSnapshot?: CostDashboardSnapshot;
  postToDiscord?: boolean;
}

const logger = createLogger("cost-dashboard");

/**
 * Reads a numeric environment value while preserving a safe fallback.
 */
function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Sums the cost categories into one total so the report stays internally consistent.
 */
function finalizeBreakdown(input: Omit<CostBreakdown, "total">): CostBreakdown {
  const total = input.llm + input.imageGen + input.marketing + input.pod;
  return {
    ...input,
    total: Number(total.toFixed(2)),
  };
}

/**
 * Formats a number as USD for console tables and Discord fields.
 */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Safely computes a profitability ratio without dividing by zero.
 */
function calculateRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return numerator > 0 ? numerator : 0;
  }
  return numerator / denominator;
}

/**
 * Returns the report file path for the current local date so each day keeps its own cost snapshot history.
 */
function getReportPath(): string {
  const dateKey = new Date().toISOString().slice(0, 10);
  return resolveProjectPath(`data/cost-report-${dateKey}.json`);
}

/**
 * Builds the console table that operators can scan quickly from the CLI or launcher.
 */
function buildCostTable(snapshot: CostDashboardSnapshot): string {
  return [
    renderTextTable(
      ["Category", "Today", "7-Day", "Budget"],
      [
        ["LLM", formatUsd(snapshot.today.llm), formatUsd(snapshot.sevenDay.llm), "-"],
        ["Image gen", formatUsd(snapshot.today.imageGen), formatUsd(snapshot.sevenDay.imageGen), formatUsd(snapshot.budgets.dailyDesignBudgetUsd)],
        ["Marketing", formatUsd(snapshot.today.marketing), formatUsd(snapshot.sevenDay.marketing), formatUsd(snapshot.budgets.weeklyAdBudgetUsd)],
        ["POD", formatUsd(snapshot.today.pod), formatUsd(snapshot.sevenDay.pod), "-"],
        ["Total spend", formatUsd(snapshot.today.total), formatUsd(snapshot.sevenDay.total), "-"],
        ["Profit", formatUsd(snapshot.todayProfit), formatUsd(snapshot.sevenDayProfit), "-"],
      ],
    ),
    "",
    renderTextTable(
      ["Metric", "Value"],
      [
        ["Today profit/spend", snapshot.ratios.todayProfitToSpend.toFixed(2)],
        ["7-day profit/spend", snapshot.ratios.sevenDayProfitToSpend.toFixed(2)],
        ["Daily design budget remaining", formatUsd(Math.max(snapshot.budgets.dailyDesignBudgetUsd - snapshot.today.imageGen, 0))],
        ["Weekly marketing budget remaining", formatUsd(Math.max(snapshot.budgets.weeklyAdBudgetUsd - snapshot.sevenDay.marketing, 0))],
      ],
    ),
    "",
    renderTextTable(
      ["Top Operations Today", "Cost", "When"],
      snapshot.topOperations.map((operation) => [
        `${operation.category}: ${operation.label}`,
        formatUsd(operation.costUsd),
        operation.occurredAt,
      ]),
    ),
  ].join("\n");
}

/**
 * Builds the Discord embed payload so operators can monitor spend and efficiency remotely.
 */
function buildCostEmbed(snapshot: CostDashboardSnapshot, preview = false): CostDashboardResult["embed"] {
  const title = preview ? "Jarvis Cost Dashboard (PREVIEW - Not Live Data)" : "Jarvis Cost Dashboard";
  const description = preview
    ? "Synthetic preview of Jarvis spend and profitability reporting."
    : "Live Jarvis spend, budget, and profitability snapshot.";

  return {
    username: "Jarvis",
    embeds: [
      {
        title,
        description,
        color: preview ? 0xffb000 : 0x00a86b,
        timestamp: snapshot.generatedAt,
        fields: [
          {
            name: "Today's Spend",
            value: `LLM ${formatUsd(snapshot.today.llm)}\nImage ${formatUsd(snapshot.today.imageGen)}\nMarketing ${formatUsd(snapshot.today.marketing)}\nPOD ${formatUsd(snapshot.today.pod)}\nTotal ${formatUsd(snapshot.today.total)}`,
            inline: true,
          },
          {
            name: "7-Day Spend",
            value: `LLM ${formatUsd(snapshot.sevenDay.llm)}\nImage ${formatUsd(snapshot.sevenDay.imageGen)}\nMarketing ${formatUsd(snapshot.sevenDay.marketing)}\nPOD ${formatUsd(snapshot.sevenDay.pod)}\nTotal ${formatUsd(snapshot.sevenDay.total)}`,
            inline: true,
          },
          {
            name: "Profitability",
            value: `Today profit ${formatUsd(snapshot.todayProfit)}\n7-day profit ${formatUsd(snapshot.sevenDayProfit)}\nToday ratio ${snapshot.ratios.todayProfitToSpend.toFixed(2)}\n7-day ratio ${snapshot.ratios.sevenDayProfitToSpend.toFixed(2)}`,
            inline: false,
          },
          {
            name: "Budgets",
            value: `Daily design ${formatUsd(snapshot.budgets.dailyDesignBudgetUsd)}\nWeekly marketing ${formatUsd(snapshot.budgets.weeklyAdBudgetUsd)}`,
            inline: true,
          },
          {
            name: "Top Operations Today",
            value: snapshot.topOperations.length > 0
              ? snapshot.topOperations.map((operation, index) => `${index + 1}. ${operation.category}: ${operation.label} (${formatUsd(operation.costUsd)})`).join("\n")
              : "No cost-bearing operations recorded today.",
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * Sends the cost dashboard embed to Discord when a webhook URL is configured.
 */
async function postCostEmbed(embed: CostDashboardResult["embed"]): Promise<void> {
  await postDiscord("cost", embed as unknown as Record<string, unknown>);
}

/**
 * Queries SQLite for the live spend and profitability snapshot across the core automation tables.
 */
function loadLiveSnapshot(): CostDashboardSnapshot {
  initializeDatabase();
  const db = getDatabase();
  const generatedAt = new Date().toISOString();

  const todayWindow = "datetime('now', 'start of day')";
  const sevenDayWindow = "datetime('now', '-7 days')";

  const llmToday = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE created_at >= ${todayWindow}`).get() as { total: number }).total ?? 0);
  const llmSevenDay = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE created_at >= ${sevenDayWindow}`).get() as { total: number }).total ?? 0);

  const imageToday = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM designs WHERE created_at >= ${todayWindow}`).get() as { total: number }).total ?? 0);
  const imageSevenDay = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM designs WHERE created_at >= ${sevenDayWindow}`).get() as { total: number }).total ?? 0);

  const marketingToday = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM marketing_events WHERE created_at >= ${todayWindow}`).get() as { total: number }).total ?? 0);
  const marketingSevenDay = Number((db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM marketing_events WHERE created_at >= ${sevenDayWindow}`).get() as { total: number }).total ?? 0);

  const podToday = Number((db.prepare(`SELECT COALESCE(SUM(MAX(total_amount - profit_amount, 0)), 0) AS total FROM orders WHERE created_at >= ${todayWindow}`).get() as { total: number }).total ?? 0);
  const podSevenDay = Number((db.prepare(`SELECT COALESCE(SUM(MAX(total_amount - profit_amount, 0)), 0) AS total FROM orders WHERE created_at >= ${sevenDayWindow}`).get() as { total: number }).total ?? 0);

  const todayProfit = Number((db.prepare(`SELECT COALESCE(SUM(profit_amount), 0) AS total FROM orders WHERE created_at >= ${todayWindow}`).get() as { total: number }).total ?? 0);
  const sevenDayProfit = Number((db.prepare(`SELECT COALESCE(SUM(profit_amount), 0) AS total FROM orders WHERE created_at >= ${sevenDayWindow}`).get() as { total: number }).total ?? 0);

  const topOperations = db.prepare(`
    SELECT category, label, cost_usd AS costUsd, occurred_at AS occurredAt
    FROM (
      SELECT 'LLM' AS category, task_type || ' via ' || model AS label, cost_usd, created_at AS occurred_at
      FROM llm_calls
      WHERE created_at >= ${todayWindow}
      UNION ALL
      SELECT 'Image gen' AS category, theme || ' (' || product_type || ')' AS label, cost_usd, created_at AS occurred_at
      FROM designs
      WHERE created_at >= ${todayWindow}
      UNION ALL
      SELECT 'Marketing' AS category, channel || ' / ' || action AS label, cost_usd, created_at AS occurred_at
      FROM marketing_events
      WHERE created_at >= ${todayWindow}
      UNION ALL
      SELECT 'POD' AS category, provider || ' receipt ' || etsy_receipt_id AS label, MAX(total_amount - profit_amount, 0) AS cost_usd, created_at AS occurred_at
      FROM orders
      WHERE created_at >= ${todayWindow}
    )
    ORDER BY cost_usd DESC, occurred_at DESC
    LIMIT 3
  `).all() as Array<{ category: string; label: string; costUsd: number; occurredAt: string }>;

  const today = finalizeBreakdown({
    llm: llmToday,
    imageGen: imageToday,
    marketing: marketingToday,
    pod: podToday,
  });
  const sevenDay = finalizeBreakdown({
    llm: llmSevenDay,
    imageGen: imageSevenDay,
    marketing: marketingSevenDay,
    pod: podSevenDay,
  });

  return {
    generatedAt,
    today,
    sevenDay,
    todayProfit,
    sevenDayProfit,
    budgets: {
      dailyDesignBudgetUsd: readNumber(process.env.DAILY_DESIGN_BUDGET_USD, 10),
      weeklyAdBudgetUsd: readNumber(process.env.WEEKLY_AD_BUDGET_USD, 20),
    },
    ratios: {
      todayProfitToSpend: Number(calculateRatio(todayProfit, today.total).toFixed(2)),
      sevenDayProfitToSpend: Number(calculateRatio(sevenDayProfit, sevenDay.total).toFixed(2)),
    },
    topOperations: topOperations.map((operation) => ({
      category: operation.category,
      label: operation.label,
      costUsd: Number(operation.costUsd ?? 0),
      occurredAt: operation.occurredAt,
    })),
  };
}

/**
 * Writes the machine-readable JSON report so operators can archive or diff cost snapshots over time.
 */
async function writeCostReport(snapshot: CostDashboardSnapshot): Promise<string> {
  const reportPath = getReportPath();
  await mkdir(resolveProjectPath("data"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return reportPath;
}

/**
 * Runs the cost dashboard in live or preview mode and optionally posts the embed to Discord.
 */
export async function runCostDashboard(options: CostDashboardOptions = {}): Promise<CostDashboardResult> {
  const snapshot = options.syntheticSnapshot ?? loadLiveSnapshot();
  const table = buildCostTable(snapshot);
  const embed = buildCostEmbed(snapshot, options.preview === true);
  const reportPath = await writeCostReport(snapshot);
  const shouldPost = options.postToDiscord ?? (!isDryRunEnabled() && options.preview !== true);

  if (shouldPost) {
    await postCostEmbed(embed);
  }

  logger.action("Cost dashboard generated", "success", {
    preview: options.preview === true,
    posted: shouldPost,
    reportPath,
    todaySpend: snapshot.today.total,
    sevenDaySpend: snapshot.sevenDay.total,
  });

  return {
    snapshot,
    table,
    reportPath,
    embed,
  };
}

/**
 * Runs the standalone cost dashboard entry point and prints the console table plus report path.
 */
async function main(): Promise<void> {
  try {
    const result = await runCostDashboard();
    console.log(result.table);
    console.log("");
    console.log(`Report saved to ${result.reportPath}`);
  } catch (error) {
    logger.error("Standalone cost dashboard execution failed", error);
    process.exitCode = 1;
  }
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  await main();
}
