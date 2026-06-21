import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getRetryableFailedOperations, type FailedOperationRecord } from "../lib/db.js";
import { incrementFailureAttempt, resolveFailure } from "../lib/dead-letter.js";
import { createLogger } from "../lib/logger.js";
import { publishListing } from "../skills/etsy-publish.js";
import { runOrderOrchestrator } from "../skills/order-orchestrator.js";
import { publishPodProduct } from "../skills/pod-publisher.js";

interface RetryOptions {
  dryRun: boolean;
}

const logger = createLogger("retry-failed-operations");

/**
 * Posts a one-off Discord alert when a dead-letter operation has exhausted all retry attempts.
 */
async function postDiscordAlert(message: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    logger.warn("Discord webhook URL is missing; dead-letter alert was not posted.", { message });
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: process.env.DISCORD_BOT_NAME?.trim() || "Jarvis",
      content: message,
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord dead-letter alert failed: ${response.status} ${response.statusText} - ${await response.text()}`);
  }
}

/**
 * Parses the stored JSON payload defensively so retry routing can stay resilient to older rows.
 */
function parsePayload(row: FailedOperationRecord): Record<string, unknown> {
  try {
    return row.payload ? JSON.parse(row.payload) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Executes one retryable operation according to its stored type and payload.
 */
async function retryOperation(row: FailedOperationRecord): Promise<void> {
  const payload = parsePayload(row);

  if (row.operation_type === "publish") {
    const listingId = Number(payload.listingId ?? row.listing_id ?? 0);
    if (!Number.isFinite(listingId) || listingId <= 0) {
      throw new Error(`Retry row ${row.id} is missing a valid listingId for publish.`);
    }
    const result = await publishListing(listingId);
    if (!result.success) {
      throw new Error(result.error ?? `Publish retry failed for listing ${listingId}.`);
    }
    return;
  }

  if (row.operation_type === "pod_upload") {
    const listingId = Number(payload.listingId ?? row.listing_id ?? 0);
    if (!Number.isFinite(listingId) || listingId <= 0) {
      throw new Error(`Retry row ${row.id} is missing a valid listingId for pod_upload.`);
    }
    const result = await publishPodProduct(listingId);
    if (!result.success) {
      throw new Error(result.error ?? `POD upload retry failed for listing ${listingId}.`);
    }
    return;
  }

  if (row.operation_type === "fulfill") {
    const result = await runOrderOrchestrator();
    if (result.failures.length > 0) {
      throw new Error(result.failures.join(" | "));
    }
    return;
  }

  throw new Error(`Unsupported failed operation type: ${row.operation_type}`);
}

/**
 * Runs the failed-operation retry loop with an optional dry-run preview mode.
 */
export async function runRetryFailedOperations(options: RetryOptions): Promise<void> {
  const rows = getRetryableFailedOperations(100);

  for (const row of rows) {
    logger.info(`Attempting retry ${row.operation_type} #${row.id} attempt ${row.attempts + 1}/5`);

    if (options.dryRun) {
      continue;
    }

    try {
      await retryOperation(row);
      resolveFailure(row.id);
    } catch (error) {
      incrementFailureAttempt(row.id);
      logger.error("Failed operation retry failed", error, {
        id: row.id,
        operationType: row.operation_type,
      });

      if (row.attempts + 1 >= 5) {
        await postDiscordAlert(
          `DEAD LETTER: ${row.operation_type} #${row.id} failed 5 times. Manual intervention required.`,
        );
      }
    }
  }
}

function parseArgs(argv: string[]): RetryOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  try {
    await runRetryFailedOperations(parseArgs(process.argv.slice(2)));
  } catch (error) {
    logger.error("Standalone retry-failed-operations execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
