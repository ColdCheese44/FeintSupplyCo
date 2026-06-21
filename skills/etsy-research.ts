import "dotenv/config";

import { pathToFileURL } from "node:url";

import { NicheRecord, getActiveNiches, initializeDatabase, insertResearchResult } from "../lib/db.js";
import { EtsySearchListing, searchActiveListings } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface ResearchOpportunity {
  nicheId: number;
  niche: string;
  keyword: string;
  score: number;
  reasoning: string;
  estimatedDemand: string;
  competitionLevel: string;
  averagePrice: number;
  listingCount: number;
}

interface ResearchStats {
  score: number;
  averageFavorites: number;
  averageAgeDays: number;
  averagePrice: number;
  listingCount: number;
  estimatedDemand: string;
  competitionLevel: string;
}

const logger = createLogger("etsy-research");

/**
 * Returns a deterministic set of research opportunities so dry-run validation stays network-free.
 */
function buildDryRunResearchOpportunities(maxResults: number): ResearchOpportunity[] {
  return [
    {
      nicheId: 1,
      niche: "Minimalist Wall Art",
      keyword: "retro minimalist wall art",
      score: 2.4831,
      reasoning: "Dry-run sample: steady favorites and moderate competition indicate plausible demand.",
      estimatedDemand: "medium",
      competitionLevel: "medium",
      averagePrice: 14.99,
      listingCount: 20,
    },
    {
      nicheId: 2,
      niche: "Printable Planner",
      keyword: "digital nostalgia planner",
      score: 1.9124,
      reasoning: "Dry-run sample: planner queries appear durable with low production cost.",
      estimatedDemand: "medium",
      competitionLevel: "high",
      averagePrice: 9.49,
      listingCount: 20,
    },
    {
      nicheId: 5,
      niche: "Digital Sticker Pack",
      keyword: "y2k sticker bundle",
      score: 1.742,
      reasoning: "Dry-run sample: sticker packs fit Jarvis low-friction test publishing patterns.",
      estimatedDemand: "high",
      competitionLevel: "medium",
      averagePrice: 6.99,
      listingCount: 20,
    },
  ].slice(0, maxResults);
}

/**
 * Converts Etsy timestamps into age in days so fast-moving listings score higher.
 */
function calculateListingAgeDays(listing: EtsySearchListing): number {
  const rawTimestamp = listing.original_creation_tsz ?? listing.creation_tsz;
  if (!rawTimestamp) {
    return 30;
  }

  const normalizedTimestamp = rawTimestamp > 9_999_999_999 ? rawTimestamp : rawTimestamp * 1_000;
  const ageMilliseconds = Date.now() - normalizedTimestamp;
  return Math.max(ageMilliseconds / (1000 * 60 * 60 * 24), 1);
}

/**
 * Converts Etsy price fields into a numeric value that can feed pricing heuristics later.
 */
function parseListingPrice(listing: EtsySearchListing): number {
  const parsed = Number(listing.price ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Converts a favorites average into a readable demand label for reports.
 */
function classifyDemand(averageFavorites: number): string {
  if (averageFavorites >= 250) {
    return "high";
  }
  if (averageFavorites >= 75) {
    return "medium";
  }
  return "low";
}

/**
 * Converts a listing count into a human-friendly competition label.
 */
function classifyCompetition(listingCount: number): string {
  if (listingCount >= 20) {
    return "high";
  }
  if (listingCount >= 10) {
    return "medium";
  }
  return "low";
}

/**
 * Aggregates search results into the opportunity score Jarvis uses for ranking niches.
 */
function calculateResearchStats(listings: EtsySearchListing[]): ResearchStats {
  const listingCount = listings.length;
  if (listingCount === 0) {
    return {
      score: 0,
      averageFavorites: 0,
      averageAgeDays: 30,
      averagePrice: 0,
      listingCount: 0,
      estimatedDemand: "low",
      competitionLevel: "low",
    };
  }

  const averageFavorites =
    listings.reduce((sum, listing) => sum + Number(listing.num_favorers ?? 0), 0) / listingCount;
  const averageAgeDays = listings.reduce((sum, listing) => sum + calculateListingAgeDays(listing), 0) / listingCount;
  const averagePrice = listings.reduce((sum, listing) => sum + parseListingPrice(listing), 0) / listingCount;
  const score = (averageFavorites / Math.max(averageAgeDays, 1)) / listingCount;

  return {
    score,
    averageFavorites,
    averageAgeDays,
    averagePrice,
    listingCount,
    estimatedDemand: classifyDemand(averageFavorites),
    competitionLevel: classifyCompetition(listingCount),
  };
}

/**
 * Turns raw scoring data into a short explanation that is useful in logs and Discord reports.
 */
function buildReasoning(niche: NicheRecord, stats: ResearchStats): string {
  return `${niche.name} shows ${stats.estimatedDemand} demand with ${stats.competitionLevel} competition. Avg favorites ${stats.averageFavorites.toFixed(
    1,
  )}, avg listing age ${stats.averageAgeDays.toFixed(1)} days, avg price $${stats.averagePrice.toFixed(2)}.`;
}

/**
 * Runs Etsy search and persistence work for a single niche.
 */
async function researchSingleNiche(niche: NicheRecord): Promise<ResearchOpportunity> {
  const listings = await searchActiveListings(niche.name, 20);
  const stats = calculateResearchStats(listings);
  const reasoning = buildReasoning(niche, stats);

  insertResearchResult({
    nicheId: niche.id,
    keyword: niche.name,
    estimatedDemand: stats.estimatedDemand,
    competitionLevel: stats.competitionLevel,
    rawData: {
      niche: niche.name,
      score: stats.score,
      averageFavorites: stats.averageFavorites,
      averageAgeDays: stats.averageAgeDays,
      averagePrice: stats.averagePrice,
      listingCount: stats.listingCount,
      sampleListings: listings.slice(0, 5),
    },
  });

  return {
    nicheId: niche.id,
    niche: niche.name,
    keyword: niche.name,
    score: Number(stats.score.toFixed(4)),
    reasoning,
    estimatedDemand: stats.estimatedDemand,
    competitionLevel: stats.competitionLevel,
    averagePrice: Number(stats.averagePrice.toFixed(2)),
    listingCount: stats.listingCount,
  };
}

/**
 * Loads active niches, researches each one, stores the results, and returns the top opportunities.
 */
export async function runEtsyResearch(maxResults = 3): Promise<ResearchOpportunity[]> {
  if (isDryRunEnabled()) {
    const opportunities = buildDryRunResearchOpportunities(maxResults);
    logger.action("Dry-run Etsy niche research completed", "skip", { returned: opportunities.length });
    return opportunities;
  }

  initializeDatabase();
  const niches = getActiveNiches();

  if (niches.length === 0) {
    logger.action("No active niches available for research", "skip");
    return [];
  }

  logger.action("Starting Etsy niche research", "start", { nicheCount: niches.length, maxResults });
  const opportunities: ResearchOpportunity[] = [];

  for (const niche of niches) {
    try {
      opportunities.push(await researchSingleNiche(niche));
    } catch (error) {
      logger.error("Failed to research niche", error, { nicheId: niche.id, niche: niche.name });
    }
  }

  const topOpportunities = opportunities.sort((left, right) => right.score - left.score).slice(0, maxResults);
  logger.action("Completed Etsy niche research", "success", { returned: topOpportunities.length });
  return topOpportunities;
}

/**
 * Parses a numeric CLI flag while preserving a safe default on bad input.
 */
function parseOptionalInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads CLI arguments for direct skill execution without introducing an extra dependency.
 */
function parseCliArgs(argv: string[]): { maxResults: number } {
  const limitIndex = argv.findIndex((argument) => argument === "--max-results");
  return {
    maxResults: parseOptionalInteger(limitIndex >= 0 ? argv[limitIndex + 1] : undefined, 3),
  };
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the direct CLI workflow and prints the resulting opportunities as JSON.
 */
async function main(): Promise<void> {
  try {
    const { maxResults } = parseCliArgs(process.argv.slice(2));
    const opportunities = await runEtsyResearch(maxResults);
    console.log(JSON.stringify(opportunities, null, 2));
  } catch (error) {
    logger.error("Standalone etsy-research execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
