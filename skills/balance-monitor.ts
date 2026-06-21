import "dotenv/config";

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { auditLog } from "../lib/audit.js";
import { getLatestProviderHealthStatuses, recordProviderHealth, getAutomationControl, setAutomationControl } from "../lib/db.js";
import { postDiscordText } from "../lib/discord.js";
import { getShopInfo } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("balance-monitor");
const REPLICATE_THRESHOLD_USD = 5;
const REPLICATE_BILLING_URL = "https://replicate.com/account/billing";

type ProviderStatus = "ok" | "degraded" | "down";

interface ProviderHealthResult {
  status: ProviderStatus;
  latencyMs: number | null;
  note?: string;
}

export interface BalanceMonitorResult {
  checkedAt: string;
  alertsSent: number;
  notes: string[];
  replicate: {
    checked: boolean;
    creditBalance?: number;
    status: "healthy" | "low" | "skipped" | "error";
  };
  providerHealth: Record<string, ProviderHealthResult>;
}

/**
 * Posts a plain-text Discord webhook alert when one provider balance or health state needs attention.
 */
async function postDiscordAlert(message: string): Promise<void> {
  await postDiscordText("watchdog", message);
}

/**
 * Persists one provider health snapshot and emits a change alert when needed.
 */
async function storeProviderHealth(
  result: BalanceMonitorResult,
  provider: string,
  health: ProviderHealthResult,
): Promise<void> {
  result.providerHealth[provider] = health;
  const latestStatuses = getLatestProviderHealthStatuses();
  const previousStatus = latestStatuses[provider]?.status ?? null;
  recordProviderHealth(provider, health.status, health.latencyMs);
  if (previousStatus !== health.status) {
    if (health.status === "down") {
      await postDiscordAlert(`PROVIDER ALERT: ${provider} is down.${health.note ? `\n${health.note}` : ""}`);
      auditLog("provider_down", "system", { provider, status: health.status, note: health.note });
      result.alertsSent += 1;
    } else if (previousStatus === "down" && health.status === "ok") {
      await postDiscordAlert(`PROVIDER RECOVERY: ${provider} is back up.`);
      result.alertsSent += 1;
    }
  }
}

/**
 * Measures one async provider probe and normalizes the outcome into ok/degraded/down with latency.
 */
async function checkProvider(
  provider: string,
  probe: () => Promise<Response | Record<string, unknown>>,
  evaluator?: (response: Response | Record<string, unknown>) => ProviderStatus,
): Promise<ProviderHealthResult> {
  const started = performance.now();
  try {
    const response = await probe();
    const latencyMs = Math.round(performance.now() - started);
    const status = evaluator ? evaluator(response) : "ok";
    return { status, latencyMs };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - started),
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Checks the Replicate account credit balance because it is the only provider in this stack with a lightweight balance API.
 */
async function checkReplicateBalance(result: BalanceMonitorResult): Promise<void> {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) {
    result.notes.push("Replicate balance check skipped - REPLICATE_API_TOKEN missing");
    result.replicate = { checked: false, status: "skipped" };
    return;
  }

  try {
    const response = await fetch("https://api.replicate.com/v1/account", {
      headers: {
        Authorization: `Token ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Replicate account lookup failed: ${response.status} ${response.statusText} - ${await response.text()}`);
    }

    const payload = (await response.json()) as { credit_balance?: number | string | null };
    const creditBalance = Number(payload.credit_balance ?? 0);
    if (!Number.isFinite(creditBalance)) {
      throw new Error(`Replicate account response did not include a numeric credit balance: ${JSON.stringify(payload)}`);
    }

    if (creditBalance < REPLICATE_THRESHOLD_USD) {
      result.replicate = {
        checked: true,
        creditBalance,
        status: "low",
      };
      if (getAutomationControl("balance_replicate_low")?.value !== "sent") {
        await postDiscordAlert(
          `BALANCE ALERT: Replicate credit low.\nEstimated remaining: $${creditBalance.toFixed(2)}\nAdd credits: ${REPLICATE_BILLING_URL}`,
        );
        setAutomationControl("balance_replicate_low", "sent", `Replicate credit low at ${creditBalance.toFixed(2)}.`);
        result.alertsSent += 1;
      }
    } else {
      result.replicate = {
        checked: true,
        creditBalance,
        status: "healthy",
      };
      setAutomationControl("balance_replicate_low", "clear", "Replicate credit healthy.");
    }
  } catch (error) {
    result.replicate = { checked: true, status: "error" };
    result.notes.push(`Replicate balance check failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.error("Replicate balance check failed", error);
  }
}

/**
 * Runs the cross-provider health probes and records the latest status for dashboard consumption.
 */
export async function checkProviderHealth(result?: BalanceMonitorResult): Promise<Record<string, ProviderHealthResult>> {
  const target = result ?? {
    checkedAt: new Date().toISOString(),
    alertsSent: 0,
    notes: [],
    replicate: { checked: false, status: "skipped" as const },
    providerHealth: {},
  };

  const etsyHealth = await checkProvider("etsy", async () => getShopInfo());
  await storeProviderHealth(target, "etsy", etsyHealth);

  const printfulHealth = await checkProvider("printful", async () => fetch("https://api.printful.com/store", {
    headers: {
      Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN?.trim() ?? ""}`,
      Accept: "application/json",
    },
  }), (response) => {
    if (response instanceof Response) {
      return response.ok ? "ok" : response.status >= 500 ? "down" : "degraded";
    }
    return "ok";
  });
  await storeProviderHealth(target, "printful", printfulHealth);

  const replicateHealth = await checkProvider("replicate", async () => fetch("https://api.replicate.com/v1/account", {
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN?.trim() ?? ""}`,
    },
  }), (response) => {
    if (response instanceof Response) {
      return response.ok ? "ok" : response.status >= 500 ? "down" : "degraded";
    }
    return "ok";
  });
  await storeProviderHealth(target, "replicate", replicateHealth);

  const anthropicHealth = await checkProvider("anthropic", async () => fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY?.trim() ?? "",
      "anthropic-version": "2023-06-01",
    },
  }), (response) => {
    if (response instanceof Response) {
      return response.ok ? "ok" : response.status >= 500 ? "down" : "degraded";
    }
    return "ok";
  });
  await storeProviderHealth(target, "anthropic", anthropicHealth);

  const imgbbHealth = await checkProvider("imgbb", async () => fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY?.trim() ?? ""}`, {
    method: "HEAD",
  }), (response) => {
    if (response instanceof Response) {
      if (response.status >= 500) {
        return "down";
      }
      return response.ok || response.status < 500 ? "ok" : "degraded";
    }
    return "ok";
  });
  await storeProviderHealth(target, "imgbb", imgbbHealth);

  return target.providerHealth;
}

/**
 * Checks provider balances and health, only emitting Discord noise when something actually changes.
 */
export async function runBalanceMonitor(): Promise<BalanceMonitorResult> {
  const result: BalanceMonitorResult = {
    checkedAt: new Date().toISOString(),
    alertsSent: 0,
    notes: [],
    replicate: {
      checked: false,
      status: "skipped",
    },
    providerHealth: {},
  };

  await checkReplicateBalance(result);
  await checkProviderHealth(result);
  result.notes.push("Anthropic balance check unavailable");
  result.notes.push("OpenAI balance check skipped - spend tracked locally");
  result.notes.push("Printify balance check skipped - pay-per-order provider");

  logger.action("Balance monitor completed", "success", result);
  return result;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  try {
    const result = await runBalanceMonitor();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.error("Standalone balance-monitor execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
