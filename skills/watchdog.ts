import "dotenv/config";

import { pathToFileURL } from "node:url";

import { initializeDatabase, setAutomationControl } from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import { readHeartbeatTimestamp } from "../lib/heartbeat-state.js";
import { createLogger } from "../lib/logger.js";

export interface WatchdogSummary {
  lastHeartbeatAt: string | null;
  ageHours: number | null;
  status: "healthy" | "warning" | "critical" | "unknown";
  alertsSent: number;
}

const logger = createLogger("watchdog");

/**
 * Posts a Discord alert when the heartbeat is stale enough to require operator attention.
 */
async function postWatchdogAlert(title: string, description: string, color: number): Promise<boolean> {
  return postDiscord("watchdog", {
    embeds: [
      {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/**
 * Converts an ISO timestamp into elapsed hours for the watchdog threshold checks.
 */
function getAgeHours(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
}

/**
 * Runs the heartbeat freshness check and escalates to Discord plus DB state when the system appears stale.
 */
export async function runWatchdog(): Promise<WatchdogSummary> {
  initializeDatabase();
  const lastHeartbeatAt = await readHeartbeatTimestamp();
  const heartbeatIntervalHours = Number(process.env.HEARTBEAT_INTERVAL_HOURS ?? "6") || 6;

  if (!lastHeartbeatAt) {
    setAutomationControl("system_stale", "true", "No successful heartbeat timestamp has been recorded yet.");
    const alertsSent = await postWatchdogAlert(
      "FeintSupplyCo heartbeat missing",
      "No successful FeintSupplyCo heartbeat timestamp has been recorded yet.",
      0xff0000,
    ) ? 1 : 0;
    const summary: WatchdogSummary = {
      lastHeartbeatAt: null,
      ageHours: null,
      status: "unknown",
      alertsSent,
    };
    logger.action("Watchdog completed", "success", summary);
    return summary;
  }

  const ageHours = getAgeHours(lastHeartbeatAt);
  let status: WatchdogSummary["status"] = "healthy";
  let alertsSent = 0;

  if (ageHours > 24) {
    status = "critical";
    setAutomationControl("system_stale", "true", `Last heartbeat is ${ageHours.toFixed(1)} hours old.`);
    if (await postWatchdogAlert(
      "FeintSupplyCo heartbeat critical",
      `FeintSupplyCo heartbeat missed - last run ${lastHeartbeatAt}. System is stale after ${ageHours.toFixed(1)} hours.`,
      0xff0000,
    )) {
      alertsSent += 1;
    }
  } else if (ageHours > heartbeatIntervalHours * 2) {
    status = "warning";
    setAutomationControl("system_stale", "false", `Heartbeat warning threshold exceeded at ${ageHours.toFixed(1)} hours.`);
    if (await postWatchdogAlert(
      "FeintSupplyCo heartbeat missed",
      `FeintSupplyCo heartbeat missed - last run ${lastHeartbeatAt}.`,
      0xffb000,
    )) {
      alertsSent += 1;
    }
  } else {
    setAutomationControl("system_stale", "false", "Heartbeat is fresh.");
  }

  const summary: WatchdogSummary = {
    lastHeartbeatAt,
    ageHours: Number(ageHours.toFixed(2)),
    status,
    alertsSent,
  };
  logger.action("Watchdog completed", "success", summary);
  return summary;
}

/**
 * Detects direct execution so the watchdog can run from npm or a task scheduler.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone watchdog entry point and prints the freshness summary as JSON.
 */
async function main(): Promise<void> {
  try {
    const summary = await runWatchdog();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone watchdog execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
