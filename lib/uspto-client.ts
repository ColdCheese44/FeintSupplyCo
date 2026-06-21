import "dotenv/config";

import { createLogger } from "./logger.js";

export interface UsptoTrademarkCase {
  serial_number?: string;
  registration_number?: string;
  mark_text?: string;
  status_code?: string;
  status?: string;
  abandonment_date?: string;
  last_owner?: string;
  nice_class?: string;
  goods_services?: string;
}

export interface UsptoSearchOptions {
  statusCodes: string[];
  niceClasses: string[];
  markText?: string;
  limit?: number;
}

const logger = createLogger("uspto-client");
const minimumRequestSpacingMs = 1100;

/**
 * Returns the configured USPTO endpoint and falls back to the TSDR case-status base URL.
 */
function getUsptoEndpoint(): string {
  return process.env.USPTO_TSDR_ENDPOINT?.trim() || "https://tsdrapi.uspto.gov/ts/cd/casestatus";
}

/**
 * Pauses execution for the supplied number of milliseconds so the client stays under the TSDR rate cap.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Normalizes a variety of USPTO response shapes into a flat trademark case list.
 */
function extractTrademarkCases(payload: unknown): UsptoTrademarkCase[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const container = payload as {
    results?: UsptoTrademarkCase[];
    items?: UsptoTrademarkCase[];
    trademarks?: UsptoTrademarkCase[];
    response?: { docs?: UsptoTrademarkCase[] };
  };

  return container.results ?? container.items ?? container.trademarks ?? container.response?.docs ?? [];
}

/**
 * Provides a small authenticated USPTO client with built-in key checks and conservative request spacing.
 */
class UsptoClient {
  private readonly apiKey: string;

  private readonly baseEndpoint: string;

  private lastRequestAt = 0;

  constructor() {
    this.apiKey = process.env.USPTO_API_KEY?.trim() ?? "";
    this.baseEndpoint = getUsptoEndpoint().replace(/\/+$/, "");
  }

  /**
   * Verifies the USPTO key exists before any network call is attempted.
   */
  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error("USPTO_API_KEY required. Register at https://developer.uspto.gov/api-catalog/tsdr-data-api");
    }
    return this.apiKey;
  }

  /**
   * Waits just over one second between requests so one process never exceeds the documented 60 req/min limit.
   */
  private async waitForTurn(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < minimumRequestSpacingMs) {
      await sleep(minimumRequestSpacingMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Executes a USPTO request with the required API key header and actionable logging for common failures.
   */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const apiKey = this.requireApiKey();
    await this.waitForTurn();

    const headers = new Headers(init.headers);
    headers.set("USPTO-API-KEY", apiKey);

    const response = await fetch(url, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      logger.warn("USPTO 401 - verify USPTO_API_KEY in .env", { url });
    } else if (response.status === 429) {
      logger.warn("USPTO rate limit hit - 60 req/min/key", { url });
    }

    return response;
  }

  /**
   * Returns the normalized TSDR base endpoint for downstream URL construction.
   */
  getBaseEndpoint(): string {
    return this.baseEndpoint;
  }
}

const usptoClient = new UsptoClient();

/**
 * Attempts to discover trademark records using the configured USPTO endpoint and permissive query parameters.
 */
export async function searchTrademarkCases(options: UsptoSearchOptions): Promise<UsptoTrademarkCase[]> {
  try {
    logger.action("Searching USPTO trademark candidates", "start", options);
    const query = new URLSearchParams({
      statusCode: options.statusCodes.join(","),
      niceClass: options.niceClasses.join(","),
      rows: String(options.limit ?? 25),
    });
    if (options.markText) {
      query.set("searchText", options.markText);
    }

    const response = await usptoClient.request(`${usptoClient.getBaseEndpoint()}?${query.toString()}`, { method: "GET" });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`USPTO search failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    const cases = extractTrademarkCases(payload);
    logger.action("Retrieved USPTO trademark candidates", "success", { count: cases.length });
    return cases;
  } catch (error) {
    logger.error("USPTO candidate search failed", error, options);
    throw new Error(`USPTO candidate search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetches a single TSDR case record using a serial or registration number when a richer dossier is needed.
 */
export async function fetchTrademarkCaseDetails(caseNumber: string): Promise<UsptoTrademarkCase | null> {
  try {
    logger.action("Fetching USPTO trademark case details", "start", { caseNumber });
    const url = `${usptoClient.getBaseEndpoint()}/${encodeURIComponent(caseNumber)}/info.json`;
    const response = await usptoClient.request(url, { method: "GET" });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`USPTO case lookup failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    const cases = extractTrademarkCases(payload);
    const firstCase = cases[0] ?? (payload as UsptoTrademarkCase);
    logger.action("Fetched USPTO trademark case details", "success", { caseNumber });
    return firstCase ?? null;
  } catch (error) {
    logger.error("USPTO case lookup failed", error, { caseNumber });
    throw new Error(`USPTO case lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Exposes the authenticated client for read-only smoke probes that need the same header and rate-limit behavior.
 */
export function getUsptoClient(): UsptoClient {
  return usptoClient;
}
