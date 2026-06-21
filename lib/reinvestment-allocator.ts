import "dotenv/config";

export interface ReinvestmentNichePerformance {
  nicheId: number;
  niche: string;
  conversionRate: number;
  revenue30d: number;
  sales30d: number;
  priority: number;
  active: boolean;
  lastSaleAt?: string | null;
}

export interface ReinvestmentListingPerformance {
  listingId: number;
  title: string;
  theme: string;
  views: number;
  conversionRate: number;
}

export interface ReinvestmentAllocationBucket {
  bucket:
    | "SCALE_WINNERS"
    | "EXPLORE_NEW"
    | "QUALITY_UPGRADE"
    | "ETSY_ADS"
    | "TRADEMARK_RESERVE"
    | "PLATFORM_EXPANSION_RESERVE";
  amountUsd: number;
  target?: string;
  note: string;
}

export interface ReinvestmentAllocationSummary {
  reinvestAmount: number;
  operatorEarnings: number;
  globalConversionRate: number;
  buckets: ReinvestmentAllocationBucket[];
  winningNiche?: string;
}

/**
 * Determines the scaling tier for a niche based on cumulative revenue and sales freshness.
 */
export function scaleNiche(cumulativeRevenue: number, lastSaleAt?: string | null): {
  tier: 0 | 1 | 2 | 3;
  maxListings: number;
  imageQuality: string;
  marketing: string;
} {
  const lastSaleAgeDays = lastSaleAt
    ? (Date.now() - new Date(lastSaleAt).getTime()) / (1000 * 60 * 60 * 24)
    : Number.POSITIVE_INFINITY;

  if (lastSaleAgeDays > 45) {
    return {
      tier: 0,
      maxListings: 3,
      imageQuality: "cheapest",
      marketing: "none",
    };
  }

  if (cumulativeRevenue >= 100) {
    return {
      tier: 3,
      maxListings: Number.MAX_SAFE_INTEGER,
      imageQuality: "best_available",
      marketing: "all_channels",
    };
  }

  if (cumulativeRevenue >= 25) {
    return {
      tier: 2,
      maxListings: 25,
      imageQuality: "premium",
      marketing: "pinterest_plus_etsy_ads",
    };
  }

  if (cumulativeRevenue >= 5) {
    return {
      tier: 1,
      maxListings: 10,
      imageQuality: "standard",
      marketing: "organic_pinterest",
    };
  }

  return {
    tier: 0,
    maxListings: 3,
    imageQuality: "cheapest",
    marketing: "none",
  };
}

/**
 * Allocates reinvestment dollars into performance-weighted buckets so each cycle funds the highest expected return first.
 */
export function allocateReinvestment(input: {
  reinvestAmount: number;
  operatorEarnings: number;
  niches: ReinvestmentNichePerformance[];
  candidateListings: ReinvestmentListingPerformance[];
}): ReinvestmentAllocationSummary {
  const globalConversionRate = input.niches.length > 0
    ? input.niches.reduce((sum, niche) => sum + niche.conversionRate, 0) / input.niches.length
    : 0;

  const provenNiches = input.niches
    .filter((niche) => niche.sales30d > 0 && niche.revenue30d > 0 && niche.conversionRate > globalConversionRate)
    .sort((left, right) => right.conversionRate - left.conversionRate || right.revenue30d - left.revenue30d);
  const winningNiche = provenNiches[0];

  const unexploredNiches = input.niches
    .filter((niche) => niche.active && niche.revenue30d <= 0 && niche.priority >= 1)
    .sort((left, right) => right.priority - left.priority);

  const qualityUpgradeTarget = input.candidateListings
    .filter((listing) => listing.views > 0)
    .sort((left, right) => right.views - left.views || left.conversionRate - right.conversionRate)
    .slice(0, Math.max(1, Math.ceil(input.candidateListings.length * 0.2)))[0];

  const allocate = (ratio: number): number => Number((input.reinvestAmount * ratio).toFixed(2));
  const buckets: ReinvestmentAllocationBucket[] = [
    {
      bucket: "SCALE_WINNERS",
      amountUsd: allocate(0.35),
      target: winningNiche?.niche,
      note: winningNiche
        ? `Scale the highest-converting niche ${winningNiche.niche}.`
        : "No niche has cleared the scale-winner threshold yet.",
    },
    {
      bucket: "EXPLORE_NEW",
      amountUsd: allocate(0.20),
      target: unexploredNiches.slice(0, 2).map((niche) => niche.niche).join(", ") || undefined,
      note: unexploredNiches.length > 0
        ? `Fund small tests for ${unexploredNiches.slice(0, 2).map((niche) => niche.niche).join(", ")}.`
        : "No unproven niches are queued for exploration.",
    },
    {
      bucket: "QUALITY_UPGRADE",
      amountUsd: allocate(0.15),
      target: qualityUpgradeTarget?.theme,
      note: qualityUpgradeTarget
        ? `Upgrade a high-view, low-conversion listing for theme ${qualityUpgradeTarget.theme}.`
        : "No low-conversion listings qualified for quality upgrade.",
    },
    {
      bucket: "ETSY_ADS",
      amountUsd: allocate(0.20),
      target: winningNiche?.niche,
      note: "Only activate after gross revenue clears the configured Etsy ads trigger.",
    },
    {
      bucket: "TRADEMARK_RESERVE",
      amountUsd: allocate(0.05),
      note: "Accumulate toward a future human-reviewed trademark filing buffer.",
    },
    {
      bucket: "PLATFORM_EXPANSION_RESERVE",
      amountUsd: allocate(0.05),
      note: "Accumulate toward Redbubble or other platform expansion.",
    },
  ];

  return {
    reinvestAmount: Number(input.reinvestAmount.toFixed(2)),
    operatorEarnings: Number(input.operatorEarnings.toFixed(2)),
    globalConversionRate: Number(globalConversionRate.toFixed(4)),
    buckets,
    winningNiche: winningNiche?.niche,
  };
}
