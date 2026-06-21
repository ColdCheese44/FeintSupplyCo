import "dotenv/config";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv, parse as parseDotenv } from "dotenv";

import {
  type CredentialEvaluation,
  evaluateCredentialManifest,
  groupManifestByProvider,
} from "../lib/credential-manifest.js";
import { renderTextTable } from "../lib/text-table.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");

/**
 * Reads the local .env file into a parsed object while preserving the difference between blank and missing keys.
 */
function readParsedEnv(): Record<string, string | undefined> {
  loadDotenv({ path: envPath });
  try {
    const contents = readFileSync(envPath, "utf8");
    return parseDotenv(contents) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/**
 * Returns the manifest evaluations grouped in the same provider order defined by the shared manifest.
 */
function groupEvaluationsByProvider(
  evaluations: CredentialEvaluation[],
): Array<{ provider: string; evaluations: CredentialEvaluation[] }> {
  const manifestGroups = groupManifestByProvider();
  return [...manifestGroups.entries()].map(([provider, entries]) => ({
    provider,
    evaluations: entries.map(
      (entry) => evaluations.find((evaluation) => evaluation.entry.key === entry.key) as CredentialEvaluation,
    ),
  }));
}

/**
 * Renders the credential-status section as provider-grouped tables.
 */
function renderStatusSection(evaluations: CredentialEvaluation[]): string {
  const sections = groupEvaluationsByProvider(evaluations).map(({ provider, evaluations: providerEvaluations }) => {
    const rows = providerEvaluations.map((evaluation) => [
      evaluation.entry.key,
      evaluation.displayStatus,
      evaluation.entry.required ? "yes" : "no",
      evaluation.formatCheck,
    ]);

    return `${provider}\n${renderTextTable(["Key", "Status", "Required?", "Format Check"], rows)}`;
  });

  return ["SECTION 1 — CREDENTIAL STATUS", "", ...sections].join("\n");
}

/**
 * Renders the missing-required section with acquisition URLs for every required key that is not valid yet.
 */
function renderMissingRequiredSection(evaluations: CredentialEvaluation[]): string {
  const failingRequired = evaluations.filter(
    (evaluation) => evaluation.entry.required && evaluation.status !== "PRESENT_VALID",
  );

  if (failingRequired.length === 0) {
    return "SECTION 2 — MISSING REQUIRED KEYS\n\n- None";
  }

  return [
    "SECTION 2 — MISSING REQUIRED KEYS",
    "",
    ...failingRequired.map(
      (evaluation) =>
        `- ${evaluation.entry.key} (${evaluation.status}) — ${evaluation.entry.acquisitionUrl}`,
    ),
  ].join("\n");
}

/**
 * Renders the blocked-feature map for any key that is missing, blank, or looks malformed.
 */
function renderBlockedFeaturesSection(evaluations: CredentialEvaluation[]): string {
  const blockingEntries = evaluations.filter((evaluation) => evaluation.status !== "PRESENT_VALID");
  if (blockingEntries.length === 0) {
    return "SECTION 3 — BLOCKED FEATURES\n\n- None";
  }

  return [
    "SECTION 3 — BLOCKED FEATURES",
    "",
    ...blockingEntries.map(
      (evaluation) =>
        `- ${evaluation.entry.key} -> ${evaluation.entry.features.join(", ")}`,
    ),
  ].join("\n");
}

/**
 * Computes the readiness score based only on required keys, which is the user's live-run threshold.
 */
function renderReadinessSection(evaluations: CredentialEvaluation[]): string {
  const requiredEntries = evaluations.filter((evaluation) => evaluation.entry.required);
  const validRequiredEntries = requiredEntries.filter((evaluation) => evaluation.status === "PRESENT_VALID");
  const readinessPercentage =
    requiredEntries.length === 0
      ? 100
      : Math.round((validRequiredEntries.length / requiredEntries.length) * 100);

  return [
    "SECTION 4 — READINESS SCORE",
    "",
    `Jarvis is ${readinessPercentage}% ready to run live. ${validRequiredEntries.length} of ${requiredEntries.length} required keys are valid.`,
  ].join("\n");
}

/**
 * Executes the full credential audit and exits non-zero until every required key is valid.
 */
function main(): void {
  const parsedEnv = readParsedEnv();
  const evaluations = evaluateCredentialManifest(parsedEnv);
  const requiredEntries = evaluations.filter((evaluation) => evaluation.entry.required);
  const validRequiredEntries = requiredEntries.filter((evaluation) => evaluation.status === "PRESENT_VALID");

  const output = [
    renderStatusSection(evaluations),
    "",
    renderMissingRequiredSection(evaluations),
    "",
    renderBlockedFeaturesSection(evaluations),
    "",
    renderReadinessSection(evaluations),
  ].join("\n");

  console.log(output);
  process.exitCode = validRequiredEntries.length === requiredEntries.length ? 0 : 1;
}

main();
