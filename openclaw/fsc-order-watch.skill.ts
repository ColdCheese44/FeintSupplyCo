import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createLogger } from "../lib/logger.js";
import { runOrderOrchestrator } from "../skills/order-orchestrator.js";

interface OpenClawOrderWatchSummary {
  orders_seen: number;
  tracking_updates: number;
  errors: string[];
}

const logger = createLogger("openclaw-fsc-order-watch");

/**
 * Runs the lightweight order watcher so OpenClaw can poll Etsy receipts on a tighter interval.
 */
export async function runOrderWatchSkill(): Promise<OpenClawOrderWatchSummary> {
  logger.action("Starting OpenClaw FeintSupplyCo order watch", "start");
  const summary = await runOrderOrchestrator();
  const result: OpenClawOrderWatchSummary = {
    orders_seen: summary.newOrders,
    tracking_updates: summary.trackingUpdates,
    errors: summary.failures,
  };
  logger.action("Completed OpenClaw FeintSupplyCo order watch", "success", result);
  return result;
}

/**
 * Detects direct execution so the wrapper can run standalone with `npm run orderwatch`.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone OpenClaw order watch wrapper entry point.
 */
async function main(): Promise<void> {
  try {
    const summary = await runOrderWatchSkill();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone OpenClaw order watch execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
