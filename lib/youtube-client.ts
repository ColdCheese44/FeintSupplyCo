import "dotenv/config";

import { createLogger } from "./logger.js";

export interface YouTubeThemeSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

interface YouTubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      publishedAt?: string;
      channelTitle?: string;
    };
  }>;
}

const logger = createLogger("youtube-client");
const youtubeApiBaseUrl = "https://www.googleapis.com/youtube/v3";

/**
 * Returns the configured YouTube API key when this optional source is enabled.
 */
function getYouTubeApiKey(): string {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is missing. Add it to .env before using YouTube trend signals.");
  }
  return apiKey;
}

/**
 * Normalizes raw YouTube titles into short commerce-friendly theme labels.
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
 * Converts result position and publish recency into a simple directional score for ranking theme momentum.
 */
function scoreYouTubeResult(index: number, publishedAt: string | undefined): number {
  const ageDays = publishedAt ? Math.max((Date.now() - Date.parse(publishedAt)) / (1000 * 60 * 60 * 24), 1) : 30;
  return Number((Math.max(0, 18 - index * 2) + Math.max(0, 30 - ageDays) / 4).toFixed(2));
}

/**
 * Searches YouTube for seed queries and converts the most relevant titles into theme signals.
 */
export async function fetchYouTubeThemeSignals(seedKeywords: string[], limit = 12): Promise<YouTubeThemeSignal[]> {
  const apiKey = getYouTubeApiKey();
  const queries = seedKeywords.slice(0, 6);
  const signals: YouTubeThemeSignal[] = [];

  logger.action("Fetching YouTube trend signals", "start", { queryCount: queries.length, limit });
  for (const query of queries) {
    const response = await fetch(
      `${youtubeApiBaseUrl}/search?${new URLSearchParams({
        key: apiKey,
        part: "snippet",
        q: query,
        type: "video",
        maxResults: "3",
        order: "viewCount",
        relevanceLanguage: "en",
      }).toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`YouTube search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as YouTubeSearchResponse;
    for (const [index, item] of (payload.items ?? []).entries()) {
      const title = item.snippet?.title?.trim();
      if (!title) {
        continue;
      }

      signals.push({
        label: extractThemeLabel(title),
        sourceScore: scoreYouTubeResult(index, item.snippet?.publishedAt),
        metadata: {
          query,
          title,
          publishedAt: item.snippet?.publishedAt ?? null,
          channelTitle: item.snippet?.channelTitle ?? null,
          videoId: item.id?.videoId ?? null,
        },
      });
    }
  }

  logger.action("Fetched YouTube trend signals", "success", { count: signals.length });
  return signals.slice(0, limit);
}
