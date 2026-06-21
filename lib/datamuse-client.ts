import "dotenv/config";

import { createLogger } from "./logger.js";

const logger = createLogger("datamuse-client");

export interface RelatedKeywordOptions {
  /** Maximum number of related keywords to return (1-50). */
  max?: number;
  /** Abort each request after this many milliseconds. */
  timeoutMs?: number;
}

interface DatamuseWord {
  word?: string;
  score?: number;
  tags?: string[];
}

/**
 * Returns whether keyword expansion is enabled (defaults to on).
 */
function isKeywordExpansionEnabled(): boolean {
  return (process.env.KEYWORD_EXPANSION_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
}

/**
 * Normalizes a Datamuse word into a clean, lowercase, tag-friendly phrase, or null when it is unusable.
 *
 * Rejects proper nouns, non-ASCII words (which would corrupt under stripping), pure numbers, and tokens
 * that are too short or too long to make sensible Etsy tags.
 */
function normalizeKeyword(entry: DatamuseWord): string | null {
  const raw = (entry.word ?? "").trim();
  if (!raw || /[^\x20-\x7E]/.test(raw)) {
    return null;
  }
  if (entry.tags?.includes("prop")) {
    return null;
  }

  const normalized = raw
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length < 3 || normalized.length > 35 || /^\d+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Calls one Datamuse endpoint and returns its raw word entries, or an empty array on any failure.
 */
async function queryDatamuse(
  endpoint: "words" | "sug",
  params: Record<string, string>,
  timeoutMs: number,
): Promise<DatamuseWord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.datamuse.com/${endpoint}?${new URLSearchParams(params).toString()}`;
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Datamuse ${endpoint} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as DatamuseWord[];
  } catch (error) {
    logger.action("Datamuse query skipped", "skip", {
      endpoint,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches related keywords for a seed phrase from the keyless Datamuse API (api.datamuse.com).
 *
 * Combines autocomplete suggestions (`sug`, real buyer-style search phrases) with means-like results
 * (`ml`), filtered for quality, to enrich Etsy tags and SEO terms. Returns an empty array on failure so
 * callers proceed without the enrichment rather than breaking the autonomous pipeline.
 */
export async function fetchRelatedKeywords(seed: string, options: RelatedKeywordOptions = {}): Promise<string[]> {
  const trimmedSeed = seed.trim();
  if (!trimmedSeed || !isKeywordExpansionEnabled()) {
    return [];
  }

  const max = Math.min(Math.max(Math.trunc(options.max ?? 20), 1), 50);
  const timeoutMs = options.timeoutMs ?? 8000;
  const seedLower = trimmedSeed.toLowerCase();

  logger.action("Fetching related keywords", "start", { seed: trimmedSeed, max });

  // Autocomplete suggestions are the highest-signal tag source; means-like fills in related concepts.
  const [suggestions, meansLike] = await Promise.all([
    queryDatamuse("sug", { s: trimmedSeed, max: "12" }, timeoutMs),
    queryDatamuse("words", { ml: trimmedSeed, max: "30", md: "p" }, timeoutMs),
  ]);

  const ordered = [...suggestions, ...meansLike];
  const keywords: string[] = [];
  const seen = new Set<string>([seedLower]);

  for (const entry of ordered) {
    const normalized = normalizeKeyword(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    keywords.push(normalized);
    if (keywords.length >= max) {
      break;
    }
  }

  logger.action("Fetched related keywords", "success", { seed: trimmedSeed, count: keywords.length });
  return keywords;
}
