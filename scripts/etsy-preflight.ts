import "dotenv/config";

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { parse as parseDotenv } from "dotenv";

import { evaluateCredentialManifest } from "../lib/credential-manifest.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");

interface PreflightOutcome {
  go: boolean;
  oauthAction: "run" | "skip";
  callbackPort: number;
  reasons: string[];
}

/**
 * Reads the local .env file so preflight decisions reflect the persisted project state.
 */
function readParsedEnv(): Record<string, string | undefined> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8")) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/**
 * Normalizes a configured callback port while keeping localhost:3000 as the safe default.
 */
function getCallbackPort(parsedEnv: Record<string, string | undefined>): number {
  const rawValue = (parsedEnv.PORT ?? process.env.PORT ?? "3000").trim();
  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 3000;
}

/**
 * Checks Windows netstat output to see whether the callback port is already occupied.
 */
function inspectPortUsage(port: number): { inUse: boolean; lines: string[] } {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `netstat -ano | findstr :${port}`], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    inUse: output.length > 0,
    lines: output,
  };
}

/**
 * Suggests the first nearby callback port that does not appear occupied on this machine.
 */
function suggestAlternatePort(startPort: number): number | null {
  for (let candidate = startPort + 1; candidate <= startPort + 10; candidate += 1) {
    if (!inspectPortUsage(candidate).inUse) {
      return candidate;
    }
  }

  return null;
}

/**
 * Prompts the operator to confirm one yes/no question without requiring extra input formats.
 */
async function askYesNo(question: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/**
 * Evaluates the Etsy key and secret using the same manifest logic as the credential audit.
 */
function evaluateEtsyCredentials(parsedEnv: Record<string, string | undefined>): { apiKeyValid: boolean; apiSecretValid: boolean; reasons: string[] } {
  const evaluations = evaluateCredentialManifest(parsedEnv);
  const apiKeyEvaluation = evaluations.find((evaluation) => evaluation.entry.key === "ETSY_API_KEY");
  const apiSecretEvaluation = evaluations.find((evaluation) => evaluation.entry.key === "ETSY_API_SECRET");
  const reasons: string[] = [];

  if (apiKeyEvaluation?.status !== "PRESENT_VALID") {
    reasons.push(`ETSY_API_KEY is not ready (${apiKeyEvaluation?.status ?? "MISSING"}).`);
  }

  if (apiSecretEvaluation?.status !== "PRESENT_VALID") {
    reasons.push(`ETSY_API_SECRET is not ready (${apiSecretEvaluation?.status ?? "MISSING"}).`);
  }

  return {
    apiKeyValid: apiKeyEvaluation?.status === "PRESENT_VALID",
    apiSecretValid: apiSecretEvaluation?.status === "PRESENT_VALID",
    reasons,
  };
}

/**
 * Runs the interactive Etsy OAuth preflight and returns a machine-readable GO/NO-GO result.
 */
async function runPreflight(): Promise<PreflightOutcome> {
  const parsedEnv = readParsedEnv();
  const callbackPort = getCallbackPort(parsedEnv);
  const reasons: string[] = [];
  let oauthAction: "run" | "skip" = "run";

  const credentialCheck = evaluateEtsyCredentials(parsedEnv);
  reasons.push(...credentialCheck.reasons);

  const portUsage = inspectPortUsage(callbackPort);
  if (portUsage.inUse) {
    const suggestedPort = suggestAlternatePort(callbackPort);
    reasons.push(
      suggestedPort
        ? `Port ${callbackPort} is already in use. Update your Etsy redirect URI to http://localhost:${suggestedPort}/oauth/callback and set PORT=${suggestedPort}.`
        : `Port ${callbackPort} is already in use. Free that port or choose another callback port and update the Etsy app redirect URI.`,
    );
  }

  console.log(`Callback port check: localhost:${callbackPort}`);
  if (portUsage.inUse) {
    console.log("Port status: IN USE");
    for (const line of portUsage.lines) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("Port status: AVAILABLE");
  }

  console.log("");
  console.log(`Reminder: register http://localhost:${callbackPort}/oauth/callback in the Etsy app dashboard before OAuth.`);
  const callbackConfirmed = await askYesNo("Confirm the Etsy app callback URL is registered exactly as shown? y/n ");
  if (!callbackConfirmed) {
    reasons.push("Callback URL registration was not confirmed.");
  }

  const accessToken = (parsedEnv.ETSY_ACCESS_TOKEN ?? "").trim();
  const refreshToken = (parsedEnv.ETSY_REFRESH_TOKEN ?? "").trim();
  if (accessToken || refreshToken) {
    const shouldReauth = await askYesNo("Existing Etsy tokens are already populated. Re-authenticate anyway? y/n ");
    if (!shouldReauth) {
      oauthAction = "skip";
      reasons.push("User chose to skip re-authentication because Etsy tokens are already populated.");
    }
  }

  const go = reasons.length === 0;
  return {
    go,
    oauthAction,
    callbackPort,
    reasons,
  };
}

/**
 * Prints the preflight verdict in both human-readable and machine-readable form for downstream orchestration.
 */
function printOutcome(outcome: PreflightOutcome): void {
  console.log("");
  if (outcome.go) {
    console.log("Pre-flight result: GO");
  } else {
    console.log("Pre-flight result: NO-GO");
    for (const reason of outcome.reasons) {
      console.log(`- ${reason}`);
    }
  }
  console.log(`OAUTH_ACTION=${outcome.oauthAction}`);
  console.log(`CALLBACK_PORT=${outcome.callbackPort}`);
}

/**
 * Runs the standalone Etsy preflight entry point and exits non-zero for any NO-GO result.
 */
async function main(): Promise<void> {
  const outcome = await runPreflight();
  printOutcome(outcome);
  process.exitCode = outcome.go ? 0 : 1;
}

await main();
