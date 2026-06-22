import "dotenv/config";

import { runEtsyAnalytics, type PerformanceSummary } from "../skills/etsy-analytics.js";
import { runCostDashboard, type CostDashboardSnapshot } from "../skills/cost-dashboard.js";

/**
 * Builds a synthetic Etsy performance snapshot so the first live digest can be previewed safely in Discord.
 */
function buildSyntheticPerformance(): PerformanceSummary[] {
  return [
    {
      listingId: 101,
      title: "Retro Arcade Sunset Tee",
      niche: "Vintage Apparel",
      views: 812,
      favorites: 74,
      sales: 29,
      revenue: 724.71,
      conversionRate: 3.57,
    },
    {
      listingId: 102,
      title: "VHS Neon Poster",
      niche: "Wall Art",
      views: 502,
      favorites: 39,
      sales: 14,
      revenue: 279.86,
      conversionRate: 2.79,
    },
    {
      listingId: 103,
      title: "Y2K Office Humor Sticker Pack",
      niche: "Stationery",
      views: 376,
      favorites: 26,
      sales: 18,
      revenue: 161.82,
      conversionRate: 4.79,
    },
  ];
}

/**
 * Builds a synthetic cost snapshot so the spend dashboard can be previewed alongside the analytics digest.
 */
function buildSyntheticCostSnapshot(): CostDashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    today: {
      llm: 1.82,
      imageGen: 3.64,
      marketing: 1.25,
      pod: 42.3,
      total: 49.01,
    },
    sevenDay: {
      llm: 8.91,
      imageGen: 22.44,
      marketing: 7.35,
      pod: 201.55,
      total: 240.25,
    },
    todayProfit: 83.44,
    sevenDayProfit: 392.7,
    budgets: {
      dailyDesignBudgetUsd: Number(process.env.DAILY_DESIGN_BUDGET_USD ?? "10") || 10,
      weeklyAdBudgetUsd: Number(process.env.WEEKLY_AD_BUDGET_USD ?? "20") || 20,
    },
    ratios: {
      todayProfitToSpend: 1.7,
      sevenDayProfitToSpend: 1.63,
    },
    topOperations: [
      {
        category: "POD",
        label: "printify receipt 4481201",
        costUsd: 18.42,
        occurredAt: new Date().toISOString(),
      },
      {
        category: "Image gen",
        label: "retro arcade typography (t-shirt)",
        costUsd: 2.14,
        occurredAt: new Date().toISOString(),
      },
      {
        category: "LLM",
        label: "listing copy via claude-sonnet",
        costUsd: 0.91,
        occurredAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Posts one deliberate preview embed to Discord so the user can tune formatting before live automation starts.
 */
async function main(): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is required before running npm run preview-digest.");
  }

  const analyticsPayload = await runEtsyAnalytics({
    previewData: buildSyntheticPerformance(),
    previewLabel: "PREVIEW - Not Live Data",
    postToDiscord: false,
  });
  const costResult = await runCostDashboard({
    preview: true,
    syntheticSnapshot: buildSyntheticCostSnapshot(),
    postToDiscord: false,
  });

  const analyticsEmbed = analyticsPayload.embeds[0];
  const costEmbed = costResult.embed.embeds[0];

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: process.env.DISCORD_BOT_NAME?.trim() || "FeintSupplyCo",
      embeds: [
        {
          title: "PREVIEW - Not Live Data",
          description: "This is a deliberate preview of the daily FeintSupplyCo Discord digest format.",
          color: 0xffb000,
          timestamp: new Date().toISOString(),
          fields: [
            ...analyticsEmbed.fields,
            ...costEmbed.fields,
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Preview digest post failed: ${response.status} ${response.statusText} - ${await response.text()}`);
  }

  console.log("Preview digest sent to Discord.");
}

await main();
