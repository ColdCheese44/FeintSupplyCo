/*
 * DISABLED BY DEFAULT:
 * Reddit trend access is gated behind REDDIT_ENABLED=true because Reddit's Responsible Builder Policy
 * may require explicit commercial approval before API use in autonomous commerce workflows.
 */
import "dotenv/config";

import { createLogger } from "./logger.js";
import { getRedditUserAgent } from "./runtime.js";

export interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  score: number;
  num_comments: number;
  ups: number;
  permalink: string;
  created_utc: number;
  url: string;
}

const logger = createLogger("reddit-client");
let cachedRedditToken: string | null = null;
let cachedExpiryTimestamp = 0;

/**
 * Returns whether Reddit access has been explicitly enabled for this environment.
 */
function isRedditEnabled(): boolean {
  return process.env.REDDIT_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Requests an application-only Reddit access token so trend mining can call the OAuth API.
 */
async function getRedditAccessToken(): Promise<string> {
  if (cachedRedditToken && Date.now() < cachedExpiryTimestamp) {
    return cachedRedditToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are required for Reddit trend mining.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": getRedditUserAgent(),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reddit OAuth failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const payload = (await response.json()) as { access_token: string; expires_in: number };
  cachedRedditToken = payload.access_token;
  cachedExpiryTimestamp = Date.now() + payload.expires_in * 1000 - 60_000;
  return cachedRedditToken;
}

/**
 * Normalizes a Reddit listing response into a flat set of post objects.
 */
function extractPosts(payload: unknown): RedditPost[] {
  const children =
    (payload as { data?: { children?: Array<{ data?: RedditPost }> } })?.data?.children ?? [];
  return children
    .map((child) => child.data)
    .filter((post): post is RedditPost => Boolean(post?.id && post.title));
}

/**
 * Fetches top posts from a subreddit so nostalgia themes can be ranked by traction.
 */
export async function fetchTopRedditPosts(subreddit: string, limit = 10, time = "week"): Promise<RedditPost[]> {
  if (!isRedditEnabled()) {
    logger.action("Reddit disabled - Responsible Builder Policy", "skip", { subreddit });
    return [];
  }

  try {
    logger.action("Fetching top Reddit posts", "start", { subreddit, limit, time });
    const token = await getRedditAccessToken();
    const query = new URLSearchParams({
      limit: String(limit),
      t: time,
    });

    const response = await fetch(`https://oauth.reddit.com/r/${subreddit}/top?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getRedditUserAgent(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Reddit subreddit fetch failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    const posts = extractPosts(payload);
    logger.action("Fetched top Reddit posts", "success", { subreddit, count: posts.length });
    return posts;
  } catch (error) {
    logger.error("Reddit subreddit fetch failed", error, { subreddit });
    throw new Error(`Reddit subreddit fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Searches a subreddit collection for a query so trademark and trend checks can estimate cultural relevance.
 */
export async function searchRedditPosts(queryText: string, subreddits: string[], limit = 10): Promise<RedditPost[]> {
  if (!isRedditEnabled()) {
    logger.action("Reddit disabled - Responsible Builder Policy", "skip", { queryText, subreddits });
    return [];
  }

  try {
    logger.action("Searching Reddit posts", "start", { queryText, subreddits, limit });
    const token = await getRedditAccessToken();
    const response = await fetch(`https://oauth.reddit.com/search?${new URLSearchParams({
      q: queryText,
      restrict_sr: "false",
      limit: String(limit),
      sort: "top",
      t: "month",
    }).toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getRedditUserAgent(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Reddit search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const posts = extractPosts(await response.json());
    const allowedSubreddits = new Set(subreddits.map((subreddit) => subreddit.toLowerCase()));
    const filtered = posts.filter((post) => allowedSubreddits.size === 0 || allowedSubreddits.has(post.subreddit.toLowerCase()));
    logger.action("Searched Reddit posts", "success", { queryText, count: filtered.length });
    return filtered;
  } catch (error) {
    logger.error("Reddit search failed", error, { queryText });
    throw new Error(`Reddit search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
