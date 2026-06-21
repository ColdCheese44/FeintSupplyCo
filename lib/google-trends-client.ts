import "dotenv/config";

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "./logger.js";

export interface GoogleTrendSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

const logger = createLogger("google-trends-client");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperScriptPath = resolve(projectRoot, "scripts", "google_trends_snapshot.py");

/**
 * Normalizes public-trend titles into the compact labels Jarvis uses across sources.
 */
function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

/**
 * Falls back to Google's public RSS feed when pytrends is unavailable on the local Python runtime.
 */
async function fetchGoogleTrendSignalsFallback(seedKeywords: string[], limit: number): Promise<GoogleTrendSignal[]> {
  const response = await fetch("https://trends.google.com/trending/rss?geo=US", {
    method: "GET",
    headers: {
      Accept: "application/rss+xml,application/xml,text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Google Trends fallback feed failed: ${response.status} ${response.statusText}`);
  }

  const xmlBody = await response.text();
  const itemTitles = [...xmlBody.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/gi)].map((match) => match[1]?.trim() ?? "");
  const normalizedSeeds = seedKeywords.map((keyword) => normalizeLabel(keyword)).filter(Boolean);
  const buildSignals = (titles: string[]): GoogleTrendSignal[] => {
    const builtSignals: GoogleTrendSignal[] = [];
    let rank = 0;
    for (const rawQuery of titles) {
      const label = normalizeLabel(rawQuery);
      if (!label) {
        continue;
      }

      rank += 1;
      builtSignals.push({
        label,
        sourceScore: Number(Math.max(1, 18 - rank).toFixed(2)),
        metadata: {
          query: rawQuery,
          rank,
          source: "google-trending-rss-fallback",
        },
      });
    }

    return builtSignals.slice(0, limit);
  };

  const filteredTitles = itemTitles.filter((rawQuery) => {
    const label = normalizeLabel(rawQuery);
    return normalizedSeeds.length === 0 || normalizedSeeds.some((seed) => label.includes(seed) || seed.includes(label));
  });

  return buildSignals(filteredTitles.length > 0 ? filteredTitles : itemTitles);
}

/**
 * Uses a Python helper backed by pytrends so Jarvis can fetch trend snapshots without depending on a brittle HTML scrape.
 */
export async function fetchGoogleTrendSignals(seedKeywords: string[], limit = 15): Promise<GoogleTrendSignal[]> {
  const pythonExecutable = process.env.PYTHON_BIN?.trim() || "python";

  return new Promise<GoogleTrendSignal[]>((resolvePromise, rejectPromise) => {
    logger.action("Fetching Google Trends signals", "start", { limit, seedCount: seedKeywords.length });
    const child = spawn(
      pythonExecutable,
      [
        helperScriptPath,
        "--keywords-json",
        JSON.stringify(seedKeywords),
        "--limit",
        String(limit),
      ],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectPromise(new Error(`Google Trends helper failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        fetchGoogleTrendSignalsFallback(seedKeywords, limit)
          .then((fallbackSignals) => {
            logger.action("Fetched Google Trends signals via fallback feed", "success", { count: fallbackSignals.length });
            resolvePromise(fallbackSignals);
          })
          .catch((fallbackError) => {
            rejectPromise(
              new Error(
                `Google Trends helper exited with code ${code}: ${(stderr || stdout).trim()} | fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
              ),
            );
          });
        return;
      }

      try {
        const payload = JSON.parse(stdout.trim()) as GoogleTrendSignal[];
        logger.action("Fetched Google Trends signals", "success", { count: payload.length });
        resolvePromise(payload);
      } catch (error) {
        rejectPromise(
          new Error(`Google Trends helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    });
  });
}
