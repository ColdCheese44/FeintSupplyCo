import "dotenv/config";

import { pathToFileURL } from "node:url";

import { initializeDatabase } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { runJarvisHeartbeatSkill } from "../openclaw/jarvis-heartbeat.skill.js";
import { runOrderOrchestrator } from "../skills/order-orchestrator.js";
import { runWatchdog } from "../skills/watchdog.js";
import { runIgmMonitor } from "../skills/igm-monitor.js";
import { isDryRunEnabled } from "../lib/runtime.js";

const logger = createLogger("jarvis-daemon");

interface ScheduledTask {
  name: string;
  intervalMs: number;
  runImmediately: boolean;
  handler: () => Promise<unknown>;
  isRunning: boolean;
  runs: number;
  failures: number;
  lastRunAt: string | null;
  timer?: NodeJS.Timeout;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Reads a positive number from the environment, falling back when the value is missing or invalid.
 */
function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns whether a boolean-style environment flag is enabled.
 */
function isFlagEnabled(value: string | undefined): boolean {
  return ["true", "1", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

/**
 * Runs one scheduled task with overlap protection and error isolation so a single failure never stops the daemon.
 */
async function runTask(task: ScheduledTask): Promise<void> {
  if (task.isRunning) {
    logger.action(`Skipping ${task.name}; previous run is still in progress`, "skip");
    return;
  }

  task.isRunning = true;
  const startedAt = Date.now();
  logger.action(`Task ${task.name} started`, "start");

  try {
    await task.handler();
    task.runs += 1;
    task.lastRunAt = new Date().toISOString();
    logger.action(`Task ${task.name} completed`, "success", {
      durationMs: Date.now() - startedAt,
      runs: task.runs,
      failures: task.failures,
    });
  } catch (error) {
    task.failures += 1;
    logger.error(`Task ${task.name} failed`, error, { failures: task.failures });
  } finally {
    task.isRunning = false;
  }
}

/**
 * Builds the schedule of autonomous tasks from environment configuration.
 */
function buildSchedule(): ScheduledTask[] {
  const heartbeatHours = readPositiveNumber(process.env.HEARTBEAT_INTERVAL_HOURS, 6);
  const orderWatchMinutes = readPositiveNumber(process.env.ORDER_WATCH_INTERVAL_MINUTES, 30);
  const watchdogMinutes = readPositiveNumber(process.env.WATCHDOG_INTERVAL_MINUTES, 60);
  const igmMinutes = readPositiveNumber(process.env.IGM_MONITOR_INTERVAL_MINUTES, 0);

  const tasks: ScheduledTask[] = [
    {
      name: "heartbeat",
      intervalMs: heartbeatHours * HOUR_MS,
      runImmediately: true,
      handler: async () => runJarvisHeartbeatSkill(),
      isRunning: false,
      runs: 0,
      failures: 0,
      lastRunAt: null,
    },
    {
      name: "order-watch",
      intervalMs: orderWatchMinutes * MINUTE_MS,
      runImmediately: false,
      handler: async () => runOrderOrchestrator(),
      isRunning: false,
      runs: 0,
      failures: 0,
      lastRunAt: null,
    },
    {
      name: "watchdog",
      intervalMs: watchdogMinutes * MINUTE_MS,
      runImmediately: false,
      handler: async () => runWatchdog(),
      isRunning: false,
      runs: 0,
      failures: 0,
      lastRunAt: null,
    },
  ];

  // IGM already runs inside the heartbeat; only add a standalone cadence when explicitly requested.
  if (igmMinutes > 0) {
    const igmEnabled = isFlagEnabled(process.env.IGM_ENABLED);
    tasks.push({
      name: "igm-monitor",
      intervalMs: igmMinutes * MINUTE_MS,
      runImmediately: false,
      handler: async () => runIgmMonitor({
        postToDiscord: igmEnabled && Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
      }),
      isRunning: false,
      runs: 0,
      failures: 0,
      lastRunAt: null,
    });
  }

  return tasks;
}

/**
 * Formats a millisecond interval as a compact human-readable cadence.
 */
function formatInterval(intervalMs: number): string {
  if (intervalMs >= HOUR_MS) {
    return `${(intervalMs / HOUR_MS).toFixed(2).replace(/\.00$/, "")}h`;
  }
  if (intervalMs >= MINUTE_MS) {
    return `${Math.round(intervalMs / MINUTE_MS)}m`;
  }
  return `${Math.round(intervalMs / 1000)}s`;
}

/**
 * Starts the autonomous daemon: runs an initial pass, then schedules each task on its own cadence.
 */
export async function startDaemon(): Promise<void> {
  initializeDatabase();
  const tasks = buildSchedule();
  const maxRuntimeMs = readPositiveNumber(process.env.JARVIS_DAEMON_MAX_RUNTIME_MS, 0);

  logger.action("Jarvis daemon starting", "start", {
    dryRun: isDryRunEnabled(),
    tasks: tasks.map((task) => ({ name: task.name, every: formatInterval(task.intervalMs), runImmediately: task.runImmediately })),
    maxRuntimeMs: maxRuntimeMs || "unlimited",
  });
  console.log("Jarvis autonomous daemon online.");
  for (const task of tasks) {
    console.log(`  • ${task.name} every ${formatInterval(task.intervalMs)}${task.runImmediately ? " (runs now, then on interval)" : ""}`);
  }
  console.log(isDryRunEnabled() ? "Mode: DRY_RUN (no live writes)." : "Mode: LIVE.");

  let shuttingDown = false;

  /**
   * Clears every interval and stops scheduling new task runs.
   */
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const task of tasks) {
      if (task.timer) {
        clearInterval(task.timer);
      }
    }
    logger.action("Jarvis daemon shutting down", "info", {
      reason,
      summary: tasks.map((task) => ({ name: task.name, runs: task.runs, failures: task.failures, lastRunAt: task.lastRunAt })),
    });
    console.log(`Jarvis daemon stopped (${reason}).`);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
    process.exit(0);
  });

  // Run the initial pass sequentially so a cold start does not fire every task at once.
  for (const task of tasks) {
    if (task.runImmediately && !shuttingDown) {
      await runTask(task);
    }
  }

  // Schedule each task on its own independent cadence.
  for (const task of tasks) {
    task.timer = setInterval(() => {
      void runTask(task);
    }, task.intervalMs);
  }

  // Optional bounded runtime keeps automated tests and supervised restarts predictable.
  if (maxRuntimeMs > 0) {
    setTimeout(() => {
      shutdown("max-runtime-reached");
      process.exit(0);
    }, maxRuntimeMs);
  }
}

/**
 * Detects direct execution so the daemon can be launched via npm or a task scheduler.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Standalone entry point that keeps the process alive while tasks are scheduled.
 */
async function main(): Promise<void> {
  try {
    await startDaemon();
  } catch (error) {
    logger.error("Jarvis daemon failed to start", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
