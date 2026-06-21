import "dotenv/config";

import { createLogger } from "./logger.js";

export interface WikipediaThemeSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

interface WikipediaSearchResponse {
  pages?: Array<{
    id?: number;
    key?: string;
    title?: string;
    excerpt?: string;
  }>;
}

interface WikipediaPageviewsResponse {
  items?: Array<{
    views?: number;
  }>;
}

const logger = createLogger("wikipedia-pageviews-client");
const wikipediaUserAgent = "JarvisEtsyAutomation/0.3 (trend research)";

/**
 * Turns longer article titles into compact signals that can merge with other trend sources.
 */
function extractThemeLabel(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

/**
 * Returns the last 30 days in the YYYYMMDD format required by the Wikimedia pageviews API.
 */
function getPageviewWindow(): { start: string; end: string } {
  const endDate = new Date();
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const formatDate = (date: Date): string =>
    `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  };
}

/**
 * Fetches the first matching Wikipedia page title for a seed query.
 */
async function searchWikipediaTitle(query: string): Promise<{ title: string; key: string } | null> {
  const response = await fetch(
    `https://en.wikipedia.org/w/rest.php/v1/search/title?${new URLSearchParams({
      q: query,
      limit: "1",
    }).toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": wikipediaUserAgent,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Wikipedia title search failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as WikipediaSearchResponse;
  const page = payload.pages?.[0];
  if (!page?.title || !page.key) {
    return null;
  }

  return {
    title: page.title,
    key: page.key,
  };
}

/**
 * Fetches trailing pageviews for a Wikipedia article key.
 */
async function fetchWikipediaPageviews(articleKey: string): Promise<number> {
  const { start, end } = getPageviewWindow();
  const response = await fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(articleKey)}/daily/${start}/${end}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": wikipediaUserAgent,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Wikipedia pageviews failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as WikipediaPageviewsResponse;
  return (payload.items ?? []).reduce((sum, item) => sum + Number(item.views ?? 0), 0);
}

/**
 * Converts Wikipedia article interest into optional theme signals without requiring any API key.
 */
export async function fetchWikipediaThemeSignals(seedKeywords: string[], limit = 10): Promise<WikipediaThemeSignal[]> {
  const signals: WikipediaThemeSignal[] = [];
  const queries = seedKeywords.slice(0, 6);

  logger.action("Fetching Wikipedia pageview signals", "start", { queryCount: queries.length, limit });
  for (const query of queries) {
    const page = await searchWikipediaTitle(query);
    if (!page) {
      continue;
    }

    const totalViews = await fetchWikipediaPageviews(page.key);
    signals.push({
      label: extractThemeLabel(page.title),
      sourceScore: Number(Math.min(totalViews / 50_000, 20).toFixed(2)),
      metadata: {
        query,
        title: page.title,
        articleKey: page.key,
        totalViews30d: totalViews,
      },
    });
  }

  logger.action("Fetched Wikipedia pageview signals", "success", { count: signals.length });
  return signals.slice(0, limit);
}
