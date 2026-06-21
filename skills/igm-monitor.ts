import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getLatestIgmSnapshot, initializeDatabase, recordIgmSnapshot } from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import {
  controlIgm,
  getIgmStatus,
  type IgmControlAction,
  type IgmStatus,
} from "../lib/igm-client.js";
import { createLogger } from "../lib/logger.js";
import { isDryRunEnabled } from "../lib/runtime.js";

const logger = createLogger("igm-monitor");

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbedPayload {
  username: string;
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: DiscordEmbedField[];
    timestamp: string;
  }>;
}

export interface IgmMonitorOptions {
  control?: IgmControlAction;
  earningsUsd?: number | null;
  postToDiscord?: boolean;
  record?: boolean;
}

export interface IgmMonitorResult {
  status: IgmStatus;
  controlMessage: string | null;
  payload: DiscordEmbedPayload;
}

/**
 * Maps an IGM status code to a Discord embed color so the digest reads at a glance.
 */
function statusColor(status: IgmStatus["status"]): number {
  switch (status) {
    case "running":
      return 0x00a86b;
    case "partial":
      return 0xffb000;
    case "stopped":
      return 0xff6b35;
    case "error":
      return 0xd7263d;
    default:
      return 0x808080;
  }
}

/**
 * Formats the running earning apps into compact text for the Discord embed.
 */
function formatContainers(status: IgmStatus): string {
  if (status.containers.length === 0) {
    return status.dockerAvailable ? "No IGM containers found." : "Docker not detected.";
  }

  return status.containers
    .slice(0, 10)
    .map((container) => `${container.state.toLowerCase() === "running" ? "🟢" : "⚪"} ${container.name} (${container.state})`)
    .join("\n");
}

/**
 * Builds the IGM Discord embed payload so passive bandwidth income reports alongside Etsy income.
 */
export function buildIgmPayload(status: IgmStatus): DiscordEmbedPayload {
  const earnings = status.reportedEarningsUsd == null
    ? "Not tracked"
    : `${status.currency} ${status.reportedEarningsUsd.toFixed(2)} (reported)`;

  return {
    username: "Jarvis",
    embeds: [
      {
        title: "Jarvis Passive Income — IGM Snapshot",
        description: "Income Generator (bandwidth-sharing) status and reported earnings.",
        color: statusColor(status.status),
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: "Status",
            value: `${status.status.toUpperCase()}\nApps running: ${status.runningApps}/${status.totalApps}`,
            inline: true,
          },
          {
            name: "Reported Earnings",
            value: earnings,
            inline: true,
          },
          {
            name: "Earning Apps",
            value: formatContainers(status),
            inline: false,
          },
          {
            name: "Notes",
            value: status.notes.length > 0 ? status.notes.map((note) => `• ${note}`).join("\n") : "All good.",
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * Posts the IGM payload to the IGM Discord channel (falling back to the shared webhook).
 */
async function postDiscordWebhook(payload: DiscordEmbedPayload): Promise<void> {
  await postDiscord("igm", payload as unknown as Record<string, unknown>);
}

/**
 * Runs an IGM monitor pass: optional control action, status read, snapshot persistence, and Discord reporting.
 */
export async function runIgmMonitor(options: IgmMonitorOptions = {}): Promise<IgmMonitorResult> {
  let controlMessage: string | null = null;

  if (options.control) {
    if (isDryRunEnabled()) {
      controlMessage = `Dry-run: skipped IGM ${options.control} action.`;
      logger.action(controlMessage, "skip", { action: options.control });
    } else {
      const result = await controlIgm(options.control);
      controlMessage = result.message;
    }
  }

  const status = await getIgmStatus();

  // Apply an explicit earnings override for this run before persisting.
  if (options.earningsUsd != null && Number.isFinite(options.earningsUsd)) {
    status.reportedEarningsUsd = options.earningsUsd;
  }

  if (options.record !== false) {
    initializeDatabase();
    recordIgmSnapshot({
      status: status.status,
      runningApps: status.runningApps,
      totalApps: status.totalApps,
      earningsUsd: status.reportedEarningsUsd,
      currency: status.currency,
      detail: { containers: status.containers, notes: status.notes, dockerAvailable: status.dockerAvailable },
    });
  }

  const payload = buildIgmPayload(status);
  if (options.postToDiscord) {
    await postDiscordWebhook(payload);
  }

  logger.action("IGM monitor pass completed", status.status === "error" ? "fail" : "success", {
    status: status.status,
    runningApps: status.runningApps,
    totalApps: status.totalApps,
    posted: options.postToDiscord === true,
  });

  return { status, controlMessage, payload };
}

/**
 * Prints a concise human-readable IGM summary to the console.
 */
function printSummary(result: IgmMonitorResult): void {
  const { status, controlMessage } = result;
  console.log("Jarvis IGM (passive bandwidth income)");
  console.log("=====================================");
  if (controlMessage) {
    console.log(`Action: ${controlMessage}`);
  }
  console.log(`Status:   ${status.status.toUpperCase()}`);
  console.log(`Apps:     ${status.runningApps}/${status.totalApps} running`);
  console.log(`Earnings: ${status.reportedEarningsUsd == null ? "not tracked" : `${status.currency} ${status.reportedEarningsUsd.toFixed(2)}`}`);
  if (status.containers.length > 0) {
    console.log("Containers:");
    for (const container of status.containers) {
      console.log(`  - ${container.name} [${container.state}] ${container.image}`);
    }
  }
  if (status.notes.length > 0) {
    console.log("Notes:");
    for (const note of status.notes) {
      console.log(`  • ${note}`);
    }
  }
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Parses CLI flags into monitor options.
 */
function parseArgs(argv: string[]): IgmMonitorOptions {
  const options: IgmMonitorOptions = {};
  if (argv.includes("--up")) {
    options.control = "up";
  } else if (argv.includes("--down")) {
    options.control = "down";
  } else if (argv.includes("--restart")) {
    options.control = "restart";
  }

  options.postToDiscord = argv.includes("--post");

  const earningsIndex = argv.findIndex((argument) => argument === "--earnings");
  if (earningsIndex >= 0 && argv[earningsIndex + 1]) {
    const parsed = Number(argv[earningsIndex + 1]);
    if (Number.isFinite(parsed)) {
      options.earningsUsd = parsed;
    }
  }

  return options;
}

/**
 * Runs the standalone IGM monitor entry point.
 */
async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runIgmMonitor(options);
    printSummary(result);
  } catch (error) {
    logger.error("Standalone IGM monitor execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
