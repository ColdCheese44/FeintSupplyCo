import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getActiveNiches, initializeDatabase, insertResearchResult } from "../lib/db.js";
import { searchActiveListings } from "../lib/etsy-client.js";
import { fetchGoogleTrendSignals, type GoogleTrendSignal } from "../lib/google-trends-client.js";
import { fetchHolidayThemeSignals, type HolidayThemeSignal } from "../lib/holidays-client.js";
import { assertLegalApproval } from "../lib/legal-filter.js";
import { createLogger } from "../lib/logger.js";
import { fetchTopRedditPosts } from "../lib/reddit-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { fetchSpotifyThemeSignals, type SpotifyThemeSignal } from "../lib/spotify-client.js";
import { fetchTikTokTrendSignals, type TikTokThemeSignal } from "../lib/tiktok-trends-client.js";
import { fetchWikipediaThemeSignals, type WikipediaThemeSignal } from "../lib/wikipedia-pageviews-client.js";
import { fetchYouTubeThemeSignals, type YouTubeThemeSignal } from "../lib/youtube-client.js";

export interface TrendThemeResult {
  theme: string;
  score: number;
  velocityScore: number;
  commercialViabilityScore: number;
  estimatedDemand: string;
  competitionLevel: string;
  reasoning: string;
  realPersonFlag: boolean;
}

type TrendSourceName =
  | "google_trends"
  | "youtube"
  | "wikipedia"
  | "tiktok"
  | "spotify"
  | "reddit"
  | "holidays";

interface SourceThemeSignal {
  label: string;
  rawLabel: string;
  source: TrendSourceName;
  sourceScore: number;
  reliabilityWeight: number;
  metadata?: Record<string, unknown>;
}

interface AggregatedThemeSignal {
  label: string;
  rawLabels: string[];
  weightedSignalScore: number;
  totalWeight: number;
  sourceBreakdown: Array<{
    source: TrendSourceName;
    sourceScore: number;
    reliabilityWeight: number;
  }>;
}

interface RealPersonAssessment {
  realPersonFlag: boolean;
  note?: string;
}

const logger = createLogger("trend-miner");
const sourceWeights: Record<TrendSourceName, number> = {
  google_trends: 0.95,
  youtube: 0.85,
  wikipedia: 0.8,
  tiktok: 0.7,
  spotify: 0.65,
  holidays: 0.6,
  reddit: 0.25,
};
const hexColorPattern = /^#?[0-9a-fA-F]{3,8}$/;
const pureNumberPattern = /^\d+$/;
const numericVsPattern = /\d+\s+vs\s+\d+/i;
const teamVsPattern = /\b[a-z]{2,}\s+vs\s+[a-z]{2,}\b/i;
const brandHighFitTerms = [
  "veteran",
  "military",
  "law enforcement",
  "cybersecurity",
  "cyber",
  "hacker",
  "operator",
  "soc",
  "osint",
  "dark aesthetic",
  "dark",
  "minimal design",
  "minimal",
  "tech culture",
  "tech",
  "service community",
  "service",
  "cold war",
  "intelligence",
  "signal",
  "comms",
  "responder",
];
const brandLowFitTerms = [
  "cottagecore",
  "kawaii",
  "bright colors",
  "floral",
  "wedding",
  "baby",
  "pastel",
  "boho",
  "farmhouse aesthetic",
  "farmhouse",
  "actor",
  "actress",
  "director",
  "musician",
  "singer",
  "rapper",
  "celebrity",
  "movie",
  "film",
  "tv",
  "television",
  "award show",
  "oscars",
  "emmys",
  "grammys",
  "reality tv",
];
const brandVocabularyTerms = [
  "signal",
  "noise",
  "veteran",
  "cyber",
  "analyst",
  "tactical",
  "investigator",
  "field",
  "operator",
  "resilience",
  "intel",
  "intelligence",
  "dispatch",
  "recon",
  "soc",
  "osint",
  "comms",
  "service",
  "tech",
];

/**
 * Returns a ranked sample of commercially plausible themes so dry-run orchestration can continue safely.
 */
function buildDryRunTrendResults(maxResults: number): TrendThemeResult[] {
  return [
    {
      theme: "quiet professional terminal humor",
      score: 9.12,
      velocityScore: 8.9,
      commercialViabilityScore: 8.4,
      estimatedDemand: "high",
      competitionLevel: "medium",
      reasoning: "Dry-run sample: high-fit operator-and-tech crossover phrase with strong merchandise potential.",
      realPersonFlag: false,
    },
    {
      theme: "cyber veteran desk setup",
      score: 8.46,
      velocityScore: 8.1,
      commercialViabilityScore: 7.9,
      estimatedDemand: "medium",
      competitionLevel: "medium",
      reasoning: "Dry-run sample: dark minimal service-to-tech aesthetics adapt well across posters, stickers, and apparel.",
      realPersonFlag: false,
    },
    {
      theme: "signal intel understatement",
      score: 7.84,
      velocityScore: 7.5,
      commercialViabilityScore: 7.1,
      estimatedDemand: "medium",
      competitionLevel: "low",
      reasoning: "Dry-run sample: restrained insider references are useful for smoke-testing the Feint product path.",
      realPersonFlag: false,
    },
  ].slice(0, maxResults);
}

/**
 * Normalizes text so public-source titles and Etsy queries can collapse into one candidate bucket.
 */
function normalizeThemeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Trims longer titles down to a compact theme phrase that still merges well across source types.
 */
function extractThemeLabel(value: string): string {
  return normalizeThemeLabel(value).split(" ").slice(0, 5).join(" ");
}

/**
 * Returns the keyword seeds Jarvis uses to orient public trend sources toward Feint Supply Co.'s operator-and-tech audience.
 */
function getThemeKeywordSeeds(): string[] {
  const nicheTokens = getActiveNiches()
    .flatMap((niche) => niche.name.toLowerCase().split(/\s+/))
    .filter((token) => token.length > 2);

  return [
    "veteran",
    "law enforcement",
    "quiet professional",
    "cybersecurity",
    "operator",
    "soc analyst",
    "osint",
    "signal",
    "comms",
    "cold war",
    "intelligence",
    "dark minimal",
    "service to tech",
    "hacker culture",
    ...nicheTokens,
  ];
}

/**
 * Scores how well a trend matches the current Feint Supply Co. brand identity.
 */
function brandFitCheck(keyword: string): { multiplier: number; label: "high" | "neutral" | "low"; reason: string } {
  const normalizedKeyword = keyword.toLowerCase();

  if (brandHighFitTerms.some((term) => normalizedKeyword.includes(term))) {
    return {
      multiplier: 1.5,
      label: "high",
      reason: "High brand fit for Feint's veteran, cyber, and quiet-professional identity.",
    };
  }

  if (brandLowFitTerms.some((term) => normalizedKeyword.includes(term))) {
    return {
      multiplier: 0.5,
      label: "low",
      reason: "Low brand fit for Feint's dark minimal operator aesthetic.",
    };
  }

  return {
    multiplier: 1,
    label: "neutral",
    reason: "Neutral brand fit.",
  };
}

/**
 * Applies a stronger penalty to entertainment or celebrity topics that have weak buyer intent and poor Feint alignment.
 */
function getEntertainmentPenalty(keyword: string, listingCount: number, averageFavorites: number, realPersonFlag: boolean): { multiplier: number; reason?: string } {
  const normalizedKeyword = keyword.toLowerCase();
  const hasBrandVocabularyMatch = brandVocabularyTerms.some((term) => normalizedKeyword.includes(term));
  const hasEntertainmentTerm = brandLowFitTerms.some((term) => normalizedKeyword.includes(term));

  if (listingCount >= 20 && averageFavorites < 20 && !hasBrandVocabularyMatch) {
    return {
      multiplier: 0.3,
      reason: "Entertainment-heavy or generic trend with weak buyer intent for Feint's niche.",
    };
  }

  if (realPersonFlag && !hasBrandVocabularyMatch) {
    return {
      multiplier: 0.4,
      reason: "Real-person entertainment trend without tactical or cyber brand relevance.",
    };
  }

  if (hasEntertainmentTerm && !hasBrandVocabularyMatch) {
    return {
      multiplier: 0.4,
      reason: "Entertainment-centric trend with low Feint brand alignment.",
    };
  }

  return { multiplier: 1 };
}

/**
 * Returns whether a raw keyword is obviously noise rather than a merchandising concept.
 */
function isRejectedNoiseCandidate(rawLabel: string, normalizedLabel: string): boolean {
  if (!normalizedLabel) {
    return true;
  }
  if (hexColorPattern.test(rawLabel) || hexColorPattern.test(normalizedLabel)) {
    return true;
  }
  if (pureNumberPattern.test(normalizedLabel)) {
    return true;
  }
  if (numericVsPattern.test(rawLabel) || teamVsPattern.test(rawLabel)) {
    return true;
  }

  const words = normalizedLabel.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].length < 5) {
    return true;
  }

  return false;
}

/**
 * Flags likely real-person themes so publishing can stop for rights review before merchandise is created.
 */
function assessRealPerson(rawLabels: string[]): RealPersonAssessment {
  const productTerms = new Set(
    getActiveNiches()
      .flatMap((niche) => niche.name.toLowerCase().split(/\s+/))
      .filter((token) => token.length >= 3),
  );

  for (const rawLabel of rawLabels) {
    const trimmed = rawLabel.trim();
    if (!/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(trimmed)) {
      continue;
    }

    const lowered = trimmed.toLowerCase();
    if (productTerms.has(lowered.split(" ")[0]) || productTerms.has(lowered.split(" ")[1])) {
      continue;
    }

    return {
      realPersonFlag: true,
      note: "REAL PERSON FLAG: Verify merchandise rights before publishing",
    };
  }

  return {
    realPersonFlag: false,
  };
}

/**
 * Converts raw source-specific results into the normalized weighted shape used by Jarvis scoring.
 */
function toSourceSignals(
  source: TrendSourceName,
  rawSignals: Array<GoogleTrendSignal | YouTubeThemeSignal | WikipediaThemeSignal | TikTokThemeSignal | SpotifyThemeSignal | HolidayThemeSignal>,
): SourceThemeSignal[] {
  return rawSignals
    .map((signal) => ({
      label: extractThemeLabel(signal.label),
      rawLabel: signal.label,
      source,
      sourceScore: signal.sourceScore,
      reliabilityWeight: sourceWeights[source],
      metadata: signal.metadata,
    }))
    .filter((signal) => signal.label.length >= 3)
    .filter((signal) => !isRejectedNoiseCandidate(signal.rawLabel, signal.label));
}

/**
 * Runs one source collector and turns missing credentials or disabled sources into silent skips rather than hard failures.
 */
async function collectSourceSafely<T>(
  source: TrendSourceName,
  loader: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await loader();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const loweredMessage = message.toLowerCase();
    const shouldSkip =
      loweredMessage.includes("missing")
      || loweredMessage.includes("disabled")
      || loweredMessage.includes("policy")
      || loweredMessage.includes("unavailable");

    if (shouldSkip) {
      logger.action("Trend source skipped", "skip", { source, reason: message });
      return [];
    }

    logger.warn("Trend source failed; reweighting remaining sources", { source, reason: message });
    return [];
  }
}

/**
 * Collects weighted theme signals from public-friendly and optional credentialed sources.
 */
async function collectThemeSignals(): Promise<SourceThemeSignal[]> {
  const seedKeywords = getThemeKeywordSeeds();
  const [
    googleTrendSignals,
    youtubeSignals,
    wikipediaSignals,
    tiktokSignals,
    spotifySignals,
    holidaySignals,
    redditSignals,
  ] = await Promise.all([
    collectSourceSafely("google_trends", () => fetchGoogleTrendSignals(seedKeywords, 15)),
    collectSourceSafely("youtube", () => fetchYouTubeThemeSignals(seedKeywords, 12)),
    collectSourceSafely("wikipedia", () => fetchWikipediaThemeSignals(seedKeywords, 10)),
    collectSourceSafely("tiktok", () => fetchTikTokTrendSignals(seedKeywords, 10)),
    collectSourceSafely("spotify", () => fetchSpotifyThemeSignals(seedKeywords, 10)),
    collectSourceSafely("holidays", () => fetchHolidayThemeSignals(seedKeywords, 8)),
    collectSourceSafely("reddit", async () => {
      const posts = await fetchTopRedditPosts("nostalgia", 6, "week");
      return posts.map((post, index) => ({
        label: post.title,
        sourceScore: Number(Math.max(1, 12 - index).toFixed(2)),
        metadata: {
          subreddit: post.subreddit,
          score: post.score,
          comments: post.num_comments,
        },
      }));
    }),
  ]);

  return [
    ...toSourceSignals("google_trends", googleTrendSignals),
    ...toSourceSignals("youtube", youtubeSignals),
    ...toSourceSignals("wikipedia", wikipediaSignals),
    ...toSourceSignals("tiktok", tiktokSignals),
    ...toSourceSignals("spotify", spotifySignals),
    ...toSourceSignals("holidays", holidaySignals),
    ...toSourceSignals("reddit", redditSignals),
  ];
}

/**
 * Merges per-source signals into a weighted candidate list that can be rescored against Etsy viability.
 */
function aggregateThemeSignals(signals: SourceThemeSignal[]): AggregatedThemeSignal[] {
  const aggregated = new Map<string, AggregatedThemeSignal>();

  for (const signal of signals) {
    const existing = aggregated.get(signal.label) ?? {
      label: signal.label,
      rawLabels: [],
      weightedSignalScore: 0,
      totalWeight: 0,
      sourceBreakdown: [],
    };

    existing.weightedSignalScore += signal.sourceScore * signal.reliabilityWeight;
    existing.totalWeight += signal.reliabilityWeight;
    existing.rawLabels.push(signal.rawLabel);
    existing.sourceBreakdown.push({
      source: signal.source,
      sourceScore: signal.sourceScore,
      reliabilityWeight: signal.reliabilityWeight,
    });
    aggregated.set(signal.label, existing);
  }

  return [...aggregated.values()].sort(
    (left, right) => (right.weightedSignalScore / right.totalWeight) - (left.weightedSignalScore / left.totalWeight),
  );
}

/**
 * Returns whether Etsy trend lookup is configured well enough to use as a commercial-viability source.
 */
function canUseEtsyTrendLookup(): boolean {
  return Boolean(
    process.env.ETSY_API_KEY?.trim()
    && process.env.ETSY_API_SECRET?.trim()
    && (process.env.ETSY_ACCESS_TOKEN?.trim() || process.env.ETSY_REFRESH_TOKEN?.trim()),
  );
}

/**
 * Converts Etsy listing count into a readable competition label for operator review.
 */
function classifyCompetition(listingCount: number): string {
  if (listingCount >= 20) {
    return "high";
  }
  if (listingCount >= 10) {
    return "medium";
  }
  if (listingCount > 0) {
    return "low";
  }
  return "unknown";
}

/**
 * Converts average favorites or a weighted source score into a coarse demand label.
 */
function classifyDemand(averageFavorites: number, fallbackVelocityScore: number): string {
  if (averageFavorites >= 200 || fallbackVelocityScore >= 9) {
    return "high";
  }
  if (averageFavorites >= 60 || fallbackVelocityScore >= 5) {
    return "medium";
  }
  return "low";
}

/**
 * Returns a lightweight commercial-category match boost based on the active niche seed names.
 */
function getCategoryMatchBoost(theme: string): number {
  const normalizedTheme = theme.toLowerCase();
  const niches = getActiveNiches();

  for (const niche of niches) {
    const nicheName = niche.name.toLowerCase();
    if (normalizedTheme.includes(nicheName) || nicheName.split(/\s+/).some((token) => token.length >= 4 && normalizedTheme.includes(token))) {
      return 1.5;
    }
  }

  return 0;
}

/**
 * Scores one aggregated theme, enriching it with Etsy viability, real-person rights checks, and commercial-fit weighting.
 */
async function scoreThemeSignal(signal: AggregatedThemeSignal): Promise<TrendThemeResult | null> {
  try {
    await assertLegalApproval({
      theme: signal.label,
      source: "trend-miner:theme",
    }, "theme");
  } catch (error) {
    logger.action("Trend candidate rejected by legal filter", "skip", {
      theme: signal.label,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const velocityScore = Number((signal.weightedSignalScore / Math.max(signal.totalWeight, 0.01)).toFixed(2));
  let listingCount = 0;
  let averageFavorites = 0;
  const brandFit = brandFitCheck(signal.label);

  if (canUseEtsyTrendLookup()) {
    const etsyListings = await searchActiveListings(signal.label, 20);
    listingCount = etsyListings.length;
    averageFavorites =
      listingCount === 0
        ? 0
        : etsyListings.reduce((sum, listing) => sum + Number(listing.num_favorers ?? 0), 0) / listingCount;

    if (listingCount === 0 && averageFavorites === 0) {
      logger.action("Trend candidate rejected for zero Etsy commercial signal", "skip", { theme: signal.label });
      return null;
    }
  }

  const sourceDiversityBonus = Math.min(signal.sourceBreakdown.length, 4) * 0.4;
  const realPersonAssessment = assessRealPerson(signal.rawLabels);
  const categoryMatchBoost = getCategoryMatchBoost(signal.label);
  const entertainmentPenalty = getEntertainmentPenalty(signal.label, listingCount, averageFavorites, realPersonAssessment.realPersonFlag);
  const provenMarketBoost = listingCount >= 5 ? 1.4 : 0;
  const demandBoost = averageFavorites > 10 ? 1.2 : 0;
  const unprovenPenalty = listingCount === 0 ? 0.65 : 1;
  const weakDemandPenalty = averageFavorites < 1 ? 0.75 : 1;
  const realPersonPenalty = realPersonAssessment.realPersonFlag ? 0.85 : 1;

  const baseCommercialScore = canUseEtsyTrendLookup()
    ? (averageFavorites / 20 + Math.min(listingCount, 20) / 2)
    : (velocityScore * 0.8 + sourceDiversityBonus);

  const commercialViabilityScore = Number(
    ((baseCommercialScore + categoryMatchBoost + provenMarketBoost + demandBoost) * unprovenPenalty * weakDemandPenalty * realPersonPenalty * entertainmentPenalty.multiplier).toFixed(2),
  );
  const score = Number(((velocityScore * 0.5 + commercialViabilityScore * 0.4 + sourceDiversityBonus * 0.1) * brandFit.multiplier).toFixed(4));
  const estimatedDemand = classifyDemand(averageFavorites, velocityScore);
  const competitionLevel = classifyCompetition(listingCount);
  const sourcesUsed = signal.sourceBreakdown.map((entry) => entry.source).join(", ");
  const realPersonNote = realPersonAssessment.note ? ` ${realPersonAssessment.note}.` : "";
  const entertainmentNote = entertainmentPenalty.reason ? ` ${entertainmentPenalty.reason}` : "";
  const reasoning = canUseEtsyTrendLookup()
    ? `${signal.label} is accelerating across ${sourcesUsed}, with ${listingCount} Etsy comps and average favorites of ${averageFavorites.toFixed(1)}. ${brandFit.reason}${entertainmentNote}${realPersonNote}`
    : `${signal.label} is accelerating across ${sourcesUsed}; Etsy viability was skipped because Etsy credentials are not configured yet. ${brandFit.reason}${entertainmentNote}${realPersonNote}`;

  insertResearchResult({
    nicheId: null,
    keyword: signal.label,
    estimatedDemand,
    competitionLevel,
    rawData: {
      theme: signal.label,
      velocityScore,
      commercialViabilityScore,
      sourceBreakdown: signal.sourceBreakdown,
      rawLabels: signal.rawLabels,
      etsyListingCount: listingCount,
      averageFavorites,
      etsyUsed: canUseEtsyTrendLookup(),
      score,
      brand_fit: brandFit.label,
      brand_fit_multiplier: brandFit.multiplier,
      real_person_flag: realPersonAssessment.realPersonFlag,
      requires_manual_review: realPersonAssessment.realPersonFlag,
      manual_review_reason: realPersonAssessment.note ?? null,
    },
  });

  return {
    theme: signal.label,
    score,
    velocityScore,
    commercialViabilityScore,
    estimatedDemand,
    competitionLevel,
    reasoning,
    realPersonFlag: realPersonAssessment.realPersonFlag,
  };
}

/**
 * Runs the Phase 2 theme-mining pipeline using commercial-friendly public sources plus optional credentialed enrichments.
 */
export async function runTrendMiner(maxResults = 10): Promise<TrendThemeResult[]> {
  if (isDryRunEnabled()) {
    const results = buildDryRunTrendResults(maxResults);
    logger.action("Dry-run trend miner completed", "skip", { returned: results.length });
    return results;
  }

  initializeDatabase();
  logger.action("Starting trend miner", "start", { maxResults, redditEnabled: process.env.REDDIT_ENABLED?.trim() === "true" });
  const sourceSignals = await collectThemeSignals();
  const aggregatedSignals = aggregateThemeSignals(sourceSignals);

  const rankedSignals: TrendThemeResult[] = [];
  for (const signal of aggregatedSignals.slice(0, 25)) {
    try {
      const scored = await scoreThemeSignal(signal);
      if (scored) {
        rankedSignals.push(scored);
      }
    } catch (error) {
      logger.error("Failed to score a trend signal", error, { signal });
    }
  }

  const result = rankedSignals.sort((left, right) => right.score - left.score).slice(0, maxResults);
  logger.action("Completed trend miner", "success", { returned: result.length, sources: sourceSignals.length });
  return result;
}

/**
 * Parses a positive integer CLI flag without throwing on malformed input.
 */
function parseOptionalInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads CLI flags for direct trend-miner execution.
 */
function parseCliArgs(argv: string[]): { maxResults: number } {
  const limitIndex = argv.findIndex((argument) => argument === "--max-results");
  return {
    maxResults: parseOptionalInteger(limitIndex >= 0 ? argv[limitIndex + 1] : undefined, 10),
  };
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone trend-miner entry point and prints the ranked themes as JSON.
 */
async function main(): Promise<void> {
  try {
    const { maxResults } = parseCliArgs(process.argv.slice(2));
    const results = await runTrendMiner(maxResults);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    logger.error("Standalone trend-miner execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
