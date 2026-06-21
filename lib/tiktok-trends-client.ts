import "dotenv/config";

import { createLogger } from "./logger.js";

export interface TikTokThemeSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

const logger = createLogger("tiktok-trends-client");
const creativeCenterUrl = "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en";
const politeUserAgent = "JarvisEtsyAutomation/0.3 (trend research; polite public page scrape)";
let lastRequestAt = 0;

/**
 * Enforces a small gap between TikTok requests so the public page is scraped politely.
 */
async function throttleTikTokRequests(minimumIntervalMs = 3000): Promise<void> {
  const now = Date.now();
  const waitMs = minimumIntervalMs - (now - lastRequestAt);
  if (waitMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
  }
  lastRequestAt = Date.now();
}

/**
 * Normalizes a raw TikTok term into the shorter label Jarvis uses across trend sources.
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
 * Extracts candidate trend terms from TikTok's public Creative Center HTML.
 */
function extractTikTokTerms(html: string): string[] {
  const patterns = [
    /"hashtag_name":"([^"]+)"/g,
    /"keyword":"([^"]+)"/g,
    /#([A-Za-z0-9_]+)/g,
  ];

  const terms = new Set<string>();
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawValue = match[1]?.trim();
      if (!rawValue) {
        continue;
      }
      terms.add(normalizeLabel(rawValue));
    }
  }

  return [...terms].filter((term) => term.length >= 3);
}

/**
 * Scrapes public TikTok Creative Center terms and filters them toward Jarvis seed niches.
 */
export async function fetchTikTokTrendSignals(seedKeywords: string[], limit = 10): Promise<TikTokThemeSignal[]> {
  await throttleTikTokRequests();
  logger.action("Fetching TikTok trend signals", "start", { limit, seedCount: seedKeywords.length });

  const response = await fetch(creativeCenterUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": politeUserAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`TikTok Creative Center fetch failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const terms = extractTikTokTerms(html);
  const normalizedSeeds = seedKeywords.map((keyword) => normalizeLabel(keyword)).filter(Boolean);
  const filteredTerms = terms.filter(
    (term) => normalizedSeeds.length === 0 || normalizedSeeds.some((seed) => term.includes(seed) || seed.includes(term)),
  );
  const chosenTerms = (filteredTerms.length > 0 ? filteredTerms : terms).slice(0, limit);

  const signals = chosenTerms.map((term, index) => ({
    label: term,
    sourceScore: Number(Math.max(1, 14 - index).toFixed(2)),
    metadata: {
      sourceUrl: creativeCenterUrl,
      rank: index + 1,
    },
  }));

  logger.action("Fetched TikTok trend signals", "success", { count: signals.length });
  return signals;
}
