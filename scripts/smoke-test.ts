import "dotenv/config";

import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv, parse as parseDotenv } from "dotenv";

import {
  type CredentialEvaluation,
  evaluateCredentialManifest,
} from "../lib/credential-manifest.js";
import { searchActiveListings } from "../lib/etsy-client.js";
import { fetchGoogleTrendSignals } from "../lib/google-trends-client.js";
import { diagnosePinterestReadAccess } from "../lib/pinterest-client.js";
import { getRedditUserAgent } from "../lib/runtime.js";
import { fetchSpotifyThemeSignals } from "../lib/spotify-client.js";
import { fetchTikTokTrendSignals } from "../lib/tiktok-trends-client.js";
import { renderTextTable } from "../lib/text-table.js";
import { getUsptoClient } from "../lib/uspto-client.js";
import { fetchWikipediaThemeSignals } from "../lib/wikipedia-pageviews-client.js";
import { fetchYouTubeThemeSignals } from "../lib/youtube-client.js";
import { runEtsyAnalytics } from "../skills/etsy-analytics.js";
import { runEtsyResearch } from "../skills/etsy-research.js";
import { generateDesignBundle } from "../skills/design-generator.js";
import { publishListing as publishLegacyListing } from "../skills/etsy-publish.js";
import { generateListingImage } from "../skills/image-gen.js";
import { runJarvisLoop } from "../skills/jarvis-loop.js";
import { generateListing } from "../skills/listing-gen.js";
import { runMarketingEngine } from "../skills/marketing-engine.js";
import { runOrderOrchestrator } from "../skills/order-orchestrator.js";
import { publishPodProduct } from "../skills/pod-publisher.js";
import { runTrademarkHunter } from "../skills/trademark-hunter.js";
import { runTrendMiner } from "../skills/trend-miner.js";

type ProviderAuthStatus =
  | "PASS"
  | "INVALID CREDENTIAL"
  | "SKIPPED - NO KEY"
  | "SKIPPED - POLICY DISABLED"
  | "UNREACHABLE"
  | "ERROR";
type FunctionalStatus =
  | "PASS"
  | "SKIP"
  | "DEGRADED"
  | "DEPENDENCY MISSING"
  | "UNREACHABLE"
  | "ERROR";

interface ComponentResult {
  component: string;
  auth: string;
  functional: string;
  remediation: string;
  note?: string;
  sample?: unknown;
}

interface SkillSmokeCase {
  name: string;
  dependenciesAll?: string[];
  dependenciesAny?: string[];
  run: () => Promise<unknown>;
}

interface ProviderDefinition {
  name: string;
  authKeys: string[];
  gateKeys: string[];
  alwaysProbe?: boolean;
  probe: () => Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }>;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");
const smokeReportPath = resolve(projectRoot, "data", "smoke-report.txt");
const verbose = process.argv.includes("--verbose");

/**
 * Reads the local .env file while preserving the difference between blank and missing keys.
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
 * Converts an unknown error into a compact message for status rows and verbose troubleshooting.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Detects the network-style failures that should render as UNREACHABLE rather than INVALID CREDENTIAL.
 */
function isNetworkError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("enotfound")
    || message.includes("econnreset")
    || message.includes("timed out")
    || message.includes("network")
    || message.includes("fetch failed");
}

/**
 * Determines whether a credential evaluation counts as present enough to make the provider look configured.
 */
function isEvaluationPresent(evaluation: CredentialEvaluation | undefined): boolean {
  return Boolean(evaluation && evaluation.status !== "BLANK" && evaluation.status !== "MISSING");
}

/**
 * Finds a credential evaluation by key name so provider and skill gates can stay readable.
 */
function findEvaluation(evaluations: CredentialEvaluation[], key: string): CredentialEvaluation | undefined {
  return evaluations.find((evaluation) => evaluation.entry.key === key);
}

/**
 * Returns whether a provider-level gate key is fully valid for feature completeness checks.
 */
function isKeyValid(evaluations: CredentialEvaluation[], key: string): boolean {
  return findEvaluation(evaluations, key)?.status === "PRESENT_VALID";
}

/**
 * Redacts any parsed .env values from a debug sample before it is printed to the terminal.
 */
function redactSecrets(value: unknown, parsedEnv: Record<string, string | undefined>): string {
  const secrets = Object.values(parsedEnv)
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .sort((left, right) => right.length - left.length);

  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  for (const secret of secrets) {
    if (secret.length < 6) {
      continue;
    }
    text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\": \"[REDACTED]\"");
  text = text.replace(/"access_token"\s*:\s*"[^"]+"/gi, "\"access_token\": \"[REDACTED]\"");
  text = text.replace(/"refresh_token"\s*:\s*"[^"]+"/gi, "\"refresh_token\": \"[REDACTED]\"");
  text = text.replace(/https:\/\/discord\.com\/api\/webhooks\/[^\s"]+/gi, "[REDACTED]");
  return text;
}

/**
 * Shrinks large provider payloads down to the first item plus counts so verbose debugging stays readable.
 */
function summarizeSample(sample: unknown): unknown {
  if (Array.isArray(sample)) {
    return {
      count: sample.length,
      first: sample[0] ?? null,
    };
  }

  if (!sample || typeof sample !== "object") {
    return sample;
  }

  const record = sample as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    return {
      count: record.data.length,
      first: record.data[0] ?? null,
    };
  }

  if (Array.isArray(record.results)) {
    return {
      count: record.results.length,
      first: record.results[0] ?? null,
    };
  }

  if (Array.isArray(record.result)) {
    return {
      count: record.result.length,
      first: record.result[0] ?? null,
    };
  }

  if (Array.isArray(record.items)) {
    return {
      count: record.items.length,
      first: record.items[0] ?? null,
    };
  }

  return sample;
}

/**
 * Reads a compact JSON-or-text preview from a response body for failure notes and verbose output.
 */
async function readBodyPreview(response: Response): Promise<unknown> {
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      return summarizeSample(await response.json());
    }
    return (await response.text()).slice(0, 240);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

/**
 * Builds a short fix suggestion for each smoke result so the table is immediately actionable.
 */
function buildRemediation(result: Omit<ComponentResult, "remediation">): string {
  if (result.component.startsWith("skill:") && result.functional === "DEPENDENCY MISSING") {
    return "Finish upstream provider setup first";
  }

  if (result.component === "Discord" && result.functional === "DEGRADED") {
    return "Expected in smoke; POST is suppressed unless ALLOW_SMOKE_DISCORD_POST=true";
  }

  if (result.component === "Printify" && result.functional === "DEGRADED") {
    return "Connect Etsy in Printify, then set PRINTIFY_SHOP_ID";
  }

  if (result.component === "USPTO" && result.auth === "SKIPPED - NO KEY") {
    return "Add USPTO_API_KEY from developer.uspto.gov";
  }

  if (result.component === "USPTO" && result.functional === "DEGRADED") {
    return "Verify USPTO_API_KEY and stay under 60 req/min/key";
  }

  if (result.component === "Pinterest" && result.auth === "INVALID CREDENTIAL") {
    return "Run npm run diagnose:pinterest and refresh token/scopes";
  }

  if (result.component === "Pinterest" && result.functional === "DEGRADED") {
    return "Set PINTEREST_BOARD_ID after a successful diagnose:pinterest";
  }

  if (result.component === "Etsy" && result.auth === "SKIPPED - NO KEY") {
    return "Run npm run etsy:oauth, then python scripts/fetch_etsy_defaults.py";
  }

  if (result.auth === "SKIPPED - NO KEY") {
    return "Populate the missing .env keys for this provider";
  }

  if (result.auth === "INVALID CREDENTIAL") {
    return "Replace the credential in .env and retry";
  }

  if (result.auth === "UNREACHABLE" || result.functional === "UNREACHABLE") {
    return "Retry when the provider endpoint is reachable";
  }

  if (result.auth === "ERROR" || result.functional === "ERROR") {
    return "Check the note or rerun with --verbose";
  }

  if (result.functional === "DEGRADED") {
    return "Review the note and complete any missing setup";
  }

  return "None";
}

/**
 * Renders a combined provider and skill table that is safe to print and safe to embed in Discord code blocks.
 */
function renderReportTable(results: ComponentResult[]): string {
  return renderTextTable(
    ["Component", "Auth", "Functional", "Remediation"],
    results.map((result) => [result.component, result.auth, result.functional, result.remediation]),
  );
}

/**
 * Renders compact component notes for failures, degraded states, and useful contextual warnings.
 */
function renderNotes(results: ComponentResult[], parsedEnv: Record<string, string | undefined>): string {
  const notedResults = results.filter((result) => result.note);
  if (notedResults.length === 0) {
    return "No notes.";
  }

  return notedResults
    .map((result) => `- ${result.component}: ${redactSecrets(result.note, parsedEnv)}`)
    .join("\n");
}

/**
 * Persists the smoke report so later review does not depend on terminal scrollback.
 */
async function saveReport(table: string, notes: string): Promise<void> {
  await writeFile(smokeReportPath, `${table}\n\nNOTES\n${notes}\n`, "utf8");
}

/**
 * Performs a read-only JSON request and normalizes 401/403 plus reachability failures into smoke-test statuses.
 */
async function probeJson(
  component: string,
  url: string,
  init: RequestInit,
): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const response = await fetch(url, init);
    if (response.status === 401 || response.status === 403) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: `${component} rejected the credentials with ${response.status}.`,
        sample: await readBodyPreview(response),
      };
    }

    if (!response.ok) {
      return {
        auth: "PASS",
        functional: "DEGRADED",
        note: `${component} responded with ${response.status} ${response.statusText}.`,
        sample: await readBodyPreview(response),
      };
    }

    return {
      auth: "PASS",
      functional: "PASS",
      sample: await readBodyPreview(response),
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks Anthropic credentials against the read-only models endpoint.
 */
async function probeAnthropic(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Anthropic", "https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
    },
  });
}

/**
 * Checks OpenAI credentials against the read-only models endpoint.
 */
async function probeOpenAI(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("OpenAI", "https://api.openai.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
      Accept: "application/json",
    },
  });
}

/**
 * Checks Replicate credentials against the public models list without triggering generation.
 */
async function probeReplicate(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Replicate", "https://api.replicate.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN ?? ""}`,
      Accept: "application/json",
    },
  });
}

/**
 * Checks Etsy credentials by running a read-only active-listings search against the authenticated API.
 */
async function probeEtsy(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const listings = await searchActiveListings("nostalgia", 1);
    return {
      auth: "PASS",
      functional: "PASS",
      sample: {
        resultCount: listings.length,
        firstResult: listings[0] ?? null,
      },
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("401") || message.includes("403")) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: message,
      };
    }

    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: message,
    };
  }
}

/**
 * Checks Printify credentials using the read-only shops listing endpoint.
 */
async function probePrintify(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Printify", "https://api.printify.com/v1/shops.json", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN ?? ""}`,
      Accept: "application/json",
    },
  });
}

/**
 * Checks Printful credentials using the read-only stores endpoint.
 */
async function probePrintful(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Printful", "https://api.printful.com/stores", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN ?? ""}`,
      Accept: "application/json",
    },
  });
}

/**
 * Checks Ideogram credentials with a HEAD probe so the smoke test stays strictly read-only.
 */
async function probeIdeogram(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const response = await fetch("https://api.ideogram.ai/v1/ideogram-v3/generate", {
      method: "HEAD",
      headers: {
        "Api-Key": process.env.IDEOGRAM_API_KEY ?? "",
      },
    });

    if (response.status === 401 || response.status === 403) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: `Ideogram rejected the credentials with ${response.status}.`,
      };
    }

    return {
      auth: "PASS",
      functional: "DEGRADED",
      sample: { status: response.status, statusText: response.statusText },
      note: "Ideogram does not expose a known safe read-only JSON probe here, so HEAD reachability was used instead.",
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks Recraft credentials against the OpenAI-compatible read-only models endpoint.
 */
async function probeRecraft(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Recraft", "https://external.api.recraft.ai/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.RECRAFT_API_KEY ?? ""}`,
      Accept: "application/json",
    },
  });
}

/**
 * Checks Pinterest token health plus the three read scopes Jarvis depends on.
 */
async function probePinterest(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const checks = await diagnosePinterestReadAccess();
    const invalidCheck = checks.find((check) => check.status === "INVALID CREDENTIAL");
    if (invalidCheck) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: `${invalidCheck.endpoint}: ${invalidCheck.note}`,
        sample: summarizeSample(checks.map((check) => ({
          endpoint: check.endpoint,
          status: check.status,
          scope: check.scope,
          note: check.note,
        }))),
      };
    }

    const unreachableCheck = checks.find((check) => check.status === "UNREACHABLE");
    if (unreachableCheck) {
      return {
        auth: "UNREACHABLE",
        functional: "UNREACHABLE",
        note: `${unreachableCheck.endpoint}: ${unreachableCheck.note}`,
      };
    }

    const degradedCheck = checks.find((check) => check.status === "DEGRADED");
    if (degradedCheck) {
      return {
        auth: "PASS",
        functional: "DEGRADED",
        note: `${degradedCheck.endpoint}: ${degradedCheck.note}`,
        sample: summarizeSample(checks),
      };
    }

    return {
      auth: "PASS",
      functional: "PASS",
      sample: summarizeSample(checks),
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks YouTube credentials by searching a single public nostalgia query.
 */
async function probeYouTube(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const signals = await fetchYouTubeThemeSignals(["retro nostalgia"], 1);
    return {
      auth: "PASS",
      functional: "PASS",
      sample: summarizeSample(signals),
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("401") || message.includes("403")) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: message,
      };
    }

    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: message,
    };
  }
}

/**
 * Checks Spotify credentials using client-credentials auth plus one read-only search call.
 */
async function probeSpotify(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const signals = await fetchSpotifyThemeSignals(["80s nostalgia"], 1);
    return {
      auth: "PASS",
      functional: "PASS",
      sample: summarizeSample(signals),
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("401") || message.includes("403")) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: message,
      };
    }

    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: message,
    };
  }
}

/**
 * Checks Google Trends using the public-friendly trend client path.
 */
async function probeGoogleTrends(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const signals = await fetchGoogleTrendSignals(["retro", "nostalgia"], 3);
    return {
      auth: "PASS",
      functional: signals.length > 0 ? "PASS" : "DEGRADED",
      sample: summarizeSample(signals),
      note: signals.length > 0 ? undefined : "Google Trends returned no matching signals.",
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks Wikipedia pageviews using the public source client.
 */
async function probeWikipedia(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const signals = await fetchWikipediaThemeSignals(["retro arcade"], 1);
    return {
      auth: "PASS",
      functional: signals.length > 0 ? "PASS" : "DEGRADED",
      sample: summarizeSample(signals),
      note: signals.length > 0 ? undefined : "Wikipedia returned no matching signals.",
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks TikTok Creative Center using the public trend scraper path.
 */
async function probeTikTok(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  try {
    const signals = await fetchTikTokTrendSignals(["retro", "nostalgia"], 3);
    return {
      auth: "PASS",
      functional: signals.length > 0 ? "PASS" : "DEGRADED",
      sample: summarizeSample(signals),
      note: signals.length > 0 ? undefined : "TikTok returned no matching signals.",
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks Reddit only when explicitly enabled because commercial access may require policy approval.
 */
async function probeReddit(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  if (process.env.REDDIT_ENABLED?.trim().toLowerCase() !== "true") {
    return {
      auth: "SKIPPED - POLICY DISABLED",
      functional: "SKIP",
      note: "Reddit disabled - Responsible Builder Policy.",
    };
  }

  try {
    const credentials = Buffer.from(`${process.env.REDDIT_CLIENT_ID ?? ""}:${process.env.REDDIT_CLIENT_SECRET ?? ""}`).toString("base64");
    const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": getRedditUserAgent(),
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (tokenResponse.status === 401 || tokenResponse.status === 403) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: `Reddit rejected the credentials with ${tokenResponse.status}.`,
      };
    }

    if (!tokenResponse.ok) {
      return {
        auth: "PASS",
        functional: "DEGRADED",
        note: `Reddit OAuth responded with ${tokenResponse.status} ${tokenResponse.statusText}.`,
      };
    }

    return {
      auth: "PASS",
      functional: "PASS",
      sample: { status: tokenResponse.status, enabled: true },
    };
  } catch (error) {
    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
  }
}

/**
 * Checks USPTO using the key-authenticated XML test URL and classifies rate-limits and invalid keys explicitly.
 */
async function probeUspto(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  const probeUrl = "https://tsdrapi.uspto.gov/ts/cd/casestatus/sn78787878/info.xml";
  const fallbackSerials = ["71016321", "73558960", "73265465"];
  const fallbackSerial = fallbackSerials[Math.abs(new Date().getUTCDate()) % fallbackSerials.length];
  const fallbackUrl = `https://tsdrapi.uspto.gov/ts/cd/casestatus/sn${fallbackSerial}/info.xml`;

  try {
    const response = await getUsptoClient().request(probeUrl, {
      method: "GET",
      headers: {
        Accept: "application/xml,text/xml",
      },
    });
    const body = await response.text();

    if (response.status === 200 && body.trim().startsWith("<")) {
      return {
        auth: "PASS",
        functional: "PASS",
        sample: { status: response.status, preview: body.slice(0, 120) },
      };
    }

    if (response.status === 401) {
      return {
        auth: "INVALID CREDENTIAL",
        functional: "SKIP",
        note: "USPTO 401 - verify USPTO_API_KEY in .env",
        sample: { status: response.status, preview: body.slice(0, 120) },
      };
    }

    if (response.status === 404) {
      const lowerBody = body.toLowerCase();
      if (lowerBody.includes("unauthorized") || lowerBody.includes("invalid api key") || lowerBody.includes("authentication")) {
        return {
          auth: "INVALID CREDENTIAL",
          functional: "SKIP",
          note: "USPTO probe returned a 404 body that still reports an authentication problem.",
          sample: { status: response.status, preview: body.slice(0, 120) },
        };
      }

      try {
        const fallbackResponse = await getUsptoClient().request(fallbackUrl, {
          method: "GET",
          headers: {
            Accept: "application/xml,text/xml",
          },
        });
        const fallbackBody = await fallbackResponse.text();
        if (fallbackResponse.status === 200 && fallbackBody.trim().startsWith("<")) {
          return {
            auth: "PASS",
            functional: "PASS",
            note: `Placeholder serial returned 404 as expected; fallback serial ${fallbackSerial} confirmed USPTO auth with 200 XML.`,
            sample: { placeholderStatus: response.status, fallbackStatus: fallbackResponse.status, fallbackSerial },
          };
        }

        return {
          auth: "PASS",
          functional: "DEGRADED",
          note: `Placeholder serial returned 404 as expected; fallback serial ${fallbackSerial} returned ${fallbackResponse.status}.`,
          sample: {
            placeholderStatus: response.status,
            fallbackStatus: fallbackResponse.status,
            fallbackSerial,
            fallbackPreview: fallbackBody.slice(0, 120),
          },
        };
      } catch (fallbackError) {
        return {
          auth: "PASS",
          functional: "DEGRADED",
          note: `Placeholder serial returned 404 as expected; fallback serial ${fallbackSerial} could not confirm functionality: ${getErrorMessage(fallbackError)}`,
          sample: { placeholderStatus: response.status, fallbackSerial },
        };
      }
    }

    if (response.status === 429) {
      return {
        auth: "PASS",
        functional: "DEGRADED",
        note: "USPTO rate limit hit - 60 req/min/key",
        sample: { status: response.status, preview: body.slice(0, 120) },
      };
    }

    return {
      auth: "PASS",
      functional: "DEGRADED",
      note: `USPTO probe returned ${response.status}.`,
      sample: { status: response.status, preview: body.slice(0, 120) },
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("USPTO_API_KEY required")) {
      return {
        auth: "SKIPPED - NO KEY",
        functional: "SKIP",
        note: message,
      };
    }

    return {
      auth: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: message,
    };
  }
}

/**
 * Checks the Discord webhook with its read-only GET endpoint but deliberately avoids posting during smoke tests.
 */
async function probeDiscord(): Promise<{ auth: ProviderAuthStatus; functional: FunctionalStatus; sample?: unknown; note?: string }> {
  return probeJson("Discord", process.env.DISCORD_WEBHOOK_URL ?? "", {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
}

const providerDefinitions: ProviderDefinition[] = [
  { name: "Anthropic", authKeys: ["ANTHROPIC_API_KEY"], gateKeys: [], probe: probeAnthropic },
  { name: "OpenAI", authKeys: ["OPENAI_API_KEY"], gateKeys: [], probe: probeOpenAI },
  { name: "Replicate", authKeys: ["REPLICATE_API_TOKEN"], gateKeys: [], probe: probeReplicate },
  {
    name: "Etsy",
    authKeys: ["ETSY_API_KEY", "ETSY_API_SECRET", "ETSY_ACCESS_TOKEN", "ETSY_REFRESH_TOKEN", "ETSY_USER_ID", "ETSY_SHOP_ID"],
    gateKeys: ["ETSY_DEFAULT_TAXONOMY_ID", "ETSY_SHIPPING_PROFILE_ID", "ETSY_READINESS_STATE_ID"],
    probe: probeEtsy,
  },
  { name: "Printify", authKeys: ["PRINTIFY_API_TOKEN"], gateKeys: ["PRINTIFY_SHOP_ID"], probe: probePrintify },
  { name: "Printful", authKeys: ["PRINTFUL_API_TOKEN"], gateKeys: [], probe: probePrintful },
  { name: "Ideogram", authKeys: ["IDEOGRAM_API_KEY"], gateKeys: [], probe: probeIdeogram },
  { name: "Recraft", authKeys: ["RECRAFT_API_KEY"], gateKeys: [], probe: probeRecraft },
  { name: "Pinterest", authKeys: ["PINTEREST_ACCESS_TOKEN"], gateKeys: ["PINTEREST_BOARD_ID"], probe: probePinterest },
  { name: "YouTube", authKeys: ["YOUTUBE_API_KEY"], gateKeys: [], probe: probeYouTube },
  { name: "Spotify", authKeys: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"], gateKeys: [], probe: probeSpotify },
  { name: "Google Trends", authKeys: [], gateKeys: [], alwaysProbe: true, probe: probeGoogleTrends },
  { name: "Wikipedia", authKeys: [], gateKeys: [], alwaysProbe: true, probe: probeWikipedia },
  { name: "TikTok", authKeys: [], gateKeys: [], alwaysProbe: true, probe: probeTikTok },
  { name: "Reddit", authKeys: ["REDDIT_ENABLED", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], gateKeys: ["REDDIT_USER_AGENT"], alwaysProbe: true, probe: probeReddit },
  { name: "USPTO", authKeys: ["USPTO_API_KEY"], gateKeys: [], probe: probeUspto },
  { name: "Discord", authKeys: ["DISCORD_WEBHOOK_URL"], gateKeys: [], probe: probeDiscord },
];

/**
 * Runs the provider probes and then downgrades functionality when supporting gate keys are still missing.
 */
async function runProviderChecks(evaluations: CredentialEvaluation[]): Promise<ComponentResult[]> {
  const results: ComponentResult[] = [];

  for (const definition of providerDefinitions) {
    const authEvaluations = definition.authKeys.map((key) => findEvaluation(evaluations, key));
    const providerConfigured = definition.alwaysProbe || authEvaluations.some((evaluation) => isEvaluationPresent(evaluation));
    const missingRequiredAuthKey = definition.name === "Etsy"
      ? !(
        isKeyValid(evaluations, "ETSY_API_KEY")
        && isKeyValid(evaluations, "ETSY_API_SECRET")
        && isKeyValid(evaluations, "ETSY_USER_ID")
        && isKeyValid(evaluations, "ETSY_SHOP_ID")
        && (isKeyValid(evaluations, "ETSY_ACCESS_TOKEN") || isKeyValid(evaluations, "ETSY_REFRESH_TOKEN"))
      )
      : !definition.alwaysProbe
        && definition.name !== "Reddit"
        && authEvaluations.some((evaluation) => !evaluation || evaluation.status === "BLANK" || evaluation.status === "MISSING");

    if (!providerConfigured || missingRequiredAuthKey) {
      const provisionalResult: Omit<ComponentResult, "remediation"> = {
        component: definition.name,
        auth: "SKIPPED - NO KEY",
        functional: "SKIP",
        note: "Provider credentials are blank or incomplete in .env.",
      };
      results.push({
        ...provisionalResult,
        remediation: buildRemediation(provisionalResult),
      });
      continue;
    }

    const probeResult = await definition.probe();
    let functional = probeResult.functional;
    const missingGateKeys = definition.gateKeys.filter((key) => !isKeyValid(evaluations, key));
    if (probeResult.auth === "PASS" && functional === "PASS" && missingGateKeys.length > 0) {
      functional = "DEGRADED";
    }

    if (definition.name === "Discord" && probeResult.auth === "PASS") {
      const provisionalResult: Omit<ComponentResult, "remediation"> = {
        component: definition.name,
        auth: probeResult.auth,
        functional: "DEGRADED",
        note: "Read-only webhook GET passed. Embed post was intentionally suppressed to honor strict no-write smoke-test mode.",
        sample: probeResult.sample,
      };
      results.push({
        ...provisionalResult,
        remediation: buildRemediation(provisionalResult),
      });
      continue;
    }

    const provisionalResult: Omit<ComponentResult, "remediation"> = {
      component: definition.name,
      auth: probeResult.auth,
      functional,
      note: missingGateKeys.length > 0
        && probeResult.auth === "PASS"
        && functional === "DEGRADED"
        ? `Missing gate keys: ${missingGateKeys.join(", ")}`
        : probeResult.note,
      sample: probeResult.sample,
    };
    results.push({
      ...provisionalResult,
      remediation: buildRemediation(provisionalResult),
    });
  }

  return results;
}

/**
 * Returns whether a provider result is strong enough for a dry-run skill dependency gate.
 */
function providerIsUsable(results: ComponentResult[], providerName: string): boolean {
  const result = results.find((item) => item.component === providerName);
  return Boolean(result && result.auth === "PASS");
}

/**
 * Executes one skill in DRY_RUN mode or reports a safe dependency-missing skip before any provider writes are possible.
 */
async function runSkillSmokeCase(results: ComponentResult[], testCase: SkillSmokeCase): Promise<ComponentResult> {
  const missingAll = (testCase.dependenciesAll ?? []).filter((providerName) => !providerIsUsable(results, providerName));
  const anyDependencies = testCase.dependenciesAny ?? [];
  const anySatisfied = anyDependencies.length === 0 || anyDependencies.some((providerName) => providerIsUsable(results, providerName));

  if (missingAll.length > 0 || !anySatisfied) {
    const missingAny = anyDependencies.length > 0 && !anySatisfied
      ? `one of ${anyDependencies.join(" | ")}`
      : "";
    const detail = [missingAll.join(", "), missingAny].filter(Boolean).join("; ");
    const provisionalResult: Omit<ComponentResult, "remediation"> = {
      component: `skill:${testCase.name}`,
      auth: "DRY_RUN",
      functional: "DEPENDENCY MISSING",
      note: detail || "Dependency gate blocked this skill.",
    };
    return {
      ...provisionalResult,
      remediation: buildRemediation(provisionalResult),
    };
  }

  try {
    const sample = await testCase.run();
    const provisionalResult: Omit<ComponentResult, "remediation"> = {
      component: `skill:${testCase.name}`,
      auth: "DRY_RUN",
      functional: "PASS",
      sample,
    };
    return {
      ...provisionalResult,
      remediation: buildRemediation(provisionalResult),
    };
  } catch (error) {
    const provisionalResult: Omit<ComponentResult, "remediation"> = {
      component: `skill:${testCase.name}`,
      auth: "DRY_RUN",
      functional: isNetworkError(error) ? "UNREACHABLE" : "ERROR",
      note: getErrorMessage(error),
    };
    return {
      ...provisionalResult,
      remediation: buildRemediation(provisionalResult),
    };
  }
}

/**
 * Posts the rendered table to Discord only when explicitly allowed, preserving strict read-only behavior by default.
 */
async function maybePostDiscordEmbed(renderedTable: string): Promise<void> {
  if (!process.env.DISCORD_WEBHOOK_URL?.trim()) {
    return;
  }

  if (process.env.ALLOW_SMOKE_DISCORD_POST?.trim().toLowerCase() !== "true") {
    return;
  }

  await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: process.env.DISCORD_BOT_NAME?.trim() || "Jarvis",
      embeds: [
        {
          title: "Jarvis Smoke Test",
          description: `\`\`\`\n${renderedTable}\n\`\`\``,
          color: 0x808080,
        },
      ],
    }),
  });
}

/**
 * Prints verbose response samples when requested, with all known .env values redacted.
 */
function printVerboseSamples(results: ComponentResult[], parsedEnv: Record<string, string | undefined>): void {
  if (!verbose) {
    return;
  }

  console.log("");
  console.log("VERBOSE SAMPLES");
  console.log("");
  for (const result of results) {
    console.log(`${result.component}`);
    if (result.note) {
      console.log(`note: ${redactSecrets(result.note, parsedEnv)}`);
    }
    if (result.sample !== undefined) {
      console.log(redactSecrets(result.sample, parsedEnv));
    } else {
      console.log("(no sample)");
    }
    console.log("");
  }
}

/**
 * Returns whether the smoke test should fail because a provider was partially configured or explicitly failed auth.
 */
function shouldFailExitCode(results: ComponentResult[], evaluations: CredentialEvaluation[]): boolean {
  return providerDefinitions.some((definition) => {
    if (definition.alwaysProbe) {
      return false;
    }

    if (definition.name === "Reddit" && process.env.REDDIT_ENABLED?.trim().toLowerCase() !== "true") {
      return false;
    }

    const authEvaluations = definition.authKeys.map((key) => findEvaluation(evaluations, key));
    const providerConfigured = authEvaluations.some((evaluation) => isEvaluationPresent(evaluation));
    if (!providerConfigured) {
      return false;
    }

    const result = results.find((item) => item.component === definition.name);
    return result?.auth !== "PASS";
  });
}

/**
 * Runs the full dry-run smoke test across providers and skills, then renders one final summary table.
 */
async function main(): Promise<void> {
  const parsedEnv = readParsedEnv();
  const evaluations = evaluateCredentialManifest(parsedEnv);
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";

  try {
    const providerResults = await runProviderChecks(evaluations);

    const skillCases: SkillSmokeCase[] = [
      {
        name: "etsy-research",
        dependenciesAll: ["Etsy"],
        run: () => runEtsyResearch(2),
      },
      {
        name: "listing-gen",
        dependenciesAny: ["Anthropic", "OpenAI"],
        run: () => generateListing({ nicheName: "Minimalist Wall Art", keyword: "retro arcade typography", productType: "poster" }),
      },
      {
        name: "image-gen",
        dependenciesAll: ["Replicate"],
        run: () => generateListingImage(9001),
      },
      {
        name: "etsy-publish",
        dependenciesAll: ["Etsy"],
        run: () => publishLegacyListing(9001),
      },
      {
        name: "etsy-analytics",
        dependenciesAll: ["Etsy"],
        run: () => runEtsyAnalytics(),
      },
      {
        name: "trend-miner",
        dependenciesAny: ["Google Trends", "Wikipedia", "TikTok", "YouTube", "Spotify", "Etsy"],
        run: () => runTrendMiner(3),
      },
      {
        name: "design-generator",
        dependenciesAny: ["Ideogram", "OpenAI", "Recraft", "Replicate"],
        run: () => generateDesignBundle({ theme: "retro arcade typography", productType: "t-shirt" }),
      },
      {
        name: "pod-publisher",
        dependenciesAll: ["Printify"],
        run: () => publishPodProduct(9001),
      },
      {
        name: "order-orchestrator",
        dependenciesAll: ["Etsy"],
        dependenciesAny: ["Printify", "Printful"],
        run: () => runOrderOrchestrator(),
      },
      {
        name: "trademark-hunter",
        dependenciesAll: ["USPTO"],
        dependenciesAny: ["Anthropic", "OpenAI"],
        run: () => runTrademarkHunter(),
      },
      {
        name: "marketing-engine",
        dependenciesAny: ["Anthropic", "OpenAI"],
        run: () => runMarketingEngine(),
      },
      {
        name: "jarvis-loop",
        run: () => runJarvisLoop(),
      },
    ];

    const skillResults: ComponentResult[] = [];
    for (const skillCase of skillCases) {
      skillResults.push(await runSkillSmokeCase(providerResults, skillCase));
    }

    const allResults = [...providerResults, ...skillResults];
    const table = renderReportTable(allResults);
    const notes = renderNotes(allResults, parsedEnv);

    console.log(table);
    console.log("");
    console.log("NOTES");
    console.log(notes);

    await saveReport(table, notes);
    printVerboseSamples(allResults, parsedEnv);
    await maybePostDiscordEmbed(table);

    process.exitCode = shouldFailExitCode(providerResults, evaluations) ? 1 : 0;
  } finally {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
  }
}

await main();
