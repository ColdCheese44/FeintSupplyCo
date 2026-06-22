import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getDatabase } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { runHeartbeatLoop } from "../skills/fsc-loop.js";

interface OpenClawHeartbeatSummary {
  listings_published: number;
  designs_generated: number;
  errors: string[];
  cost_total: number;
}

const logger = createLogger("openclaw-fsc-heartbeat");

/**
 * Reads the OpenClaw heartbeat toggles and aligns the underlying FeintSupplyCo loop env before execution.
 */
function prepareHeartbeatEnvironment(): { originalDiscordWebhook?: string } {
  process.env.PUBLISH_INTERVAL_HOURS = process.env.HEARTBEAT_INTERVAL_HOURS?.trim() || process.env.PUBLISH_INTERVAL_HOURS || "6";
  const shouldReport = (process.env.HEARTBEAT_DISCORD_REPORT?.trim().toLowerCase() ?? "true") !== "false";
  const originalDiscordWebhook = process.env.DISCORD_WEBHOOK_URL;
  if (!shouldReport) {
    delete process.env.DISCORD_WEBHOOK_URL;
  }
  return { originalDiscordWebhook };
}

/**
 * Estimates the direct cost recorded during the most recent heartbeat from local DB tables.
 */
function estimateRecentCost(designIds: number[]): number {
  const db = getDatabase();
  const designCost = designIds.length > 0
    ? (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM designs WHERE id IN (${designIds.map(() => "?").join(",")})`)
      .get(...designIds) as { total: number }).total
    : 0;
  const llmCost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE created_at >= datetime('now', '-15 minutes')").get() as { total: number }).total;
  const marketingCost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM marketing_events WHERE created_at >= datetime('now', '-15 minutes')").get() as { total: number }).total;
  return Number((designCost + llmCost + marketingCost).toFixed(4));
}

/**
 * Runs the FeintSupplyCo heartbeat as an OpenClaw-friendly skill and returns a compact structured summary.
 */
export async function runHeartbeatSkill(): Promise<OpenClawHeartbeatSummary> {
  const environmentSnapshot = prepareHeartbeatEnvironment();
  logger.action("Starting OpenClaw FeintSupplyCo heartbeat wrapper", "start", {
    intervalHours: process.env.PUBLISH_INTERVAL_HOURS,
    discordReport: process.env.HEARTBEAT_DISCORD_REPORT ?? "true",
  });

  try {
    const summary = await runHeartbeatLoop();
    const result: OpenClawHeartbeatSummary = {
      listings_published: summary.productsPublished.length,
      designs_generated: summary.designsGenerated.length,
      errors: summary.failures,
      cost_total: estimateRecentCost(summary.designsGenerated),
    };
    logger.action("Completed OpenClaw FeintSupplyCo heartbeat wrapper", "success", result);
    return result;
  } finally {
    if (environmentSnapshot.originalDiscordWebhook !== undefined) {
      process.env.DISCORD_WEBHOOK_URL = environmentSnapshot.originalDiscordWebhook;
    }
  }
}

/**
 * Detects direct execution so the wrapper can run standalone with `npm run heartbeat`.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone OpenClaw heartbeat wrapper entry point.
 */
async function main(): Promise<void> {
  try {
    const summary = await runHeartbeatSkill();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone OpenClaw heartbeat execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
