import "dotenv/config";

import { createLogger } from "./logger.js";

export interface SpotifyThemeSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

interface SpotifySearchResponse {
  tracks?: {
    items?: Array<{
      name?: string;
      popularity?: number;
      external_urls?: { spotify?: string };
      album?: { release_date?: string };
    }>;
  };
}

const logger = createLogger("spotify-client");
let cachedSpotifyToken: string | null = null;
let cachedSpotifyExpiryTimestamp = 0;

/**
 * Returns the configured Spotify client credentials when this optional source is enabled.
 */
function getSpotifyCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required for Spotify trend signals.");
  }
  return { clientId, clientSecret };
}

/**
 * Exchanges client credentials for a Spotify app token and caches it for subsequent calls.
 */
async function getSpotifyAccessToken(): Promise<string> {
  if (cachedSpotifyToken && Date.now() < cachedSpotifyExpiryTimestamp) {
    return cachedSpotifyToken;
  }

  const { clientId, clientSecret } = getSpotifyCredentials();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Spotify token request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error("Spotify token response did not include an access token.");
  }

  cachedSpotifyToken = payload.access_token;
  cachedSpotifyExpiryTimestamp = Date.now() + Number(payload.expires_in ?? 3600) * 1000 - 60_000;
  return cachedSpotifyToken;
}

/**
 * Converts music titles into compact normalized nostalgia-theme labels.
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
 * Searches Spotify tracks for era-themed seed queries and turns high-popularity matches into optional theme signals.
 */
export async function fetchSpotifyThemeSignals(seedKeywords: string[], limit = 10): Promise<SpotifyThemeSignal[]> {
  const token = await getSpotifyAccessToken();
  const queries = seedKeywords.slice(0, 5);
  const signals: SpotifyThemeSignal[] = [];

  logger.action("Fetching Spotify trend signals", "start", { queryCount: queries.length, limit });
  for (const query of queries) {
    const response = await fetch(
      `https://api.spotify.com/v1/search?${new URLSearchParams({
        q: query,
        type: "track",
        limit: "3",
      }).toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Spotify search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as SpotifySearchResponse;
    for (const track of payload.tracks?.items ?? []) {
      if (!track.name) {
        continue;
      }

      signals.push({
        label: normalizeLabel(track.name),
        sourceScore: Number(((track.popularity ?? 0) / 10).toFixed(2)),
        metadata: {
          query,
          title: track.name,
          popularity: track.popularity ?? 0,
          releaseDate: track.album?.release_date ?? null,
          url: track.external_urls?.spotify ?? null,
        },
      });
    }
  }

  logger.action("Fetched Spotify trend signals", "success", { count: signals.length });
  return signals.slice(0, limit);
}
