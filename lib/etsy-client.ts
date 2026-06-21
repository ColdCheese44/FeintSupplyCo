import "dotenv/config";

import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { createLogger } from "./logger.js";

export interface EtsySearchListing {
  listing_id: number;
  title: string;
  url?: string;
  num_favorers?: number;
  views?: number;
  creation_tsz?: number;
  original_creation_tsz?: number;
  price?: number | string;
  currency_code?: string;
  taxonomy_id?: number;
  tags?: string[];
}

export interface EtsyDraftListingPayload {
  title: string;
  description: string;
  price: number;
  quantity?: number;
  taxonomyId?: number;
  whoMade?: string;
  whenMade?: string;
  type?: "physical" | "download";
  isSupply?: boolean;
  shippingProfileId?: number;
  readinessStateId?: number;
  shopSectionId?: number | string;
  tags: string[];
}

export interface EtsyDraftListingResponse {
  listing_id: number | string;
  url?: string;
  state?: string;
}

export interface EtsyPublishResult {
  success: boolean;
  etsyListingId: string;
  listingUrl: string;
}

export interface EtsyListingMetrics {
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
}

export interface EtsyReceiptTransactionRecord {
  listing_id?: number;
  quantity?: number;
  price?: number | string;
  title?: string;
  variations?: Array<{
    property_name?: string;
    formatted_name?: string;
    value?: string;
    formatted_value?: string;
  }>;
}

export interface EtsyReceiptRecord {
  receipt_id: number;
  buyer_user_id?: number;
  name?: string;
  first_line?: string;
  second_line?: string;
  city?: string;
  state?: string;
  zip?: string;
  country_iso?: string;
  grandtotal?: number | string;
  creation_tsz?: number;
  transactions?: EtsyReceiptTransactionRecord[];
}

export interface EtsyShopSection {
  shop_section_id: number | string;
  title: string;
}

export interface EtsyShippingProfile {
  shipping_profile_id: number | string;
  title?: string;
}

export interface EtsyShopUpdatePayload {
  title?: string;
  announcement?: string;
  saleMessage?: string;
  policyWelcome?: string;
  policyPayment?: string;
  policyShipping?: string;
  policyRefunds?: string;
  policyAdditional?: string;
}

export interface EtsyImageUploadResult {
  success: boolean;
  responseBody: string;
}

export interface EtsyShopUpdateResult {
  coreApplied: string[];
  policiesApplied: boolean;
  policiesManualRequired: boolean;
  policyErrorMessage?: string;
}

interface EtsyListResponse<T> {
  count?: number;
  results: T[];
}

const logger = createLogger("etsy-client");
const etsyApiBaseUrl = "https://api.etsy.com/v3";

/**
 * Reads the latest Etsy access token from the local .env file so long-running processes do not keep using a stale startup value.
 */
function getLiveEtsyToken(): string {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(/^ETSY_ACCESS_TOKEN=(.+)$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  } catch {
    // Fall back to the current process environment below.
  }

  return process.env.ETSY_ACCESS_TOKEN?.trim() ?? "";
}

/**
 * Persists a refreshed Etsy token to both .env and the active process environment.
 */
function writeTokenToEnv(key: "ETSY_ACCESS_TOKEN" | "ETSY_REFRESH_TOKEN", value: string): void {
  const envPath = resolve(process.cwd(), ".env");
  let content = readFileSync(envPath, "utf-8");
  const nextLine = `${key}=${value}`;

  if (new RegExp(`^${key}=.*$`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), nextLine);
  } else {
    content = `${content.replace(/\s*$/, "")}\n${nextLine}\n`;
  }

  writeFileSync(envPath, content, "utf-8");
  process.env[key] = value;
}

/**
 * Returns the header value Etsy expects for application authentication.
 */
function getApiKeyHeaderValue(): string {
  const apiKey = process.env.ETSY_API_KEY?.trim();
  const apiSecret = process.env.ETSY_API_SECRET?.trim();

  if (!apiKey || !apiSecret) {
    throw new Error("ETSY_API_KEY and ETSY_API_SECRET are required for Etsy API calls.");
  }

  return `${apiKey}:${apiSecret}`;
}

/**
 * Returns the configured shop ID and fails fast when it is missing.
 */
function getShopId(): string {
  const shopId = process.env.ETSY_SHOP_ID?.trim();
  if (!shopId) {
    throw new Error("ETSY_SHOP_ID is missing. Add it to the project .env file before using Etsy skills.");
  }
  return shopId;
}

/**
 * Returns the configured Etsy user ID so user-scoped endpoints never rely on the broken /users/me alias.
 */
function getUserId(): string {
  const userId = process.env.ETSY_USER_ID?.trim();
  if (!userId) {
    throw new Error("ETSY_USER_ID is missing. Add it to the project .env file before using Etsy skills.");
  }
  return userId;
}

/**
 * Builds the standard Etsy headers for authenticated API requests.
 */
function buildHeaders(accessToken: string): Headers {
  const headers = new Headers();
  headers.set("x-api-key", getApiKeyHeaderValue());
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  return headers;
}

/**
 * Refreshes the Etsy access token when a stored refresh token is available.
 */
export async function refreshEtsyToken(): Promise<string> {
  const clientId = process.env.ETSY_API_KEY?.trim();
  const refreshToken = process.env.ETSY_REFRESH_TOKEN?.trim();

  if (!clientId || !refreshToken) {
    throw new Error("ETSY_REFRESH_TOKEN is missing and the Etsy access token could not be refreshed.");
  }

  const response = await fetch(`${etsyApiBaseUrl}/public/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Etsy token refresh failed", new Error(errorText), {
      status: response.status,
      statusText: response.statusText,
      errorText,
    });
    throw new Error("Etsy token refresh failed - run npm run go-live to re-authenticate");
  }

  const payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!payload.access_token) {
    throw new Error("Etsy refresh response did not include a new access token.");
  }

  writeTokenToEnv("ETSY_ACCESS_TOKEN", payload.access_token);
  if (payload.refresh_token?.trim()) {
    writeTokenToEnv("ETSY_REFRESH_TOKEN", payload.refresh_token.trim());
  }

  process.env.ETSY_ACCESS_TOKEN = payload.access_token;
  if (payload.refresh_token?.trim()) {
    process.env.ETSY_REFRESH_TOKEN = payload.refresh_token.trim();
  }

  logger.action("Etsy token refreshed successfully", "success");
  return payload.access_token;
}

/**
 * Returns the current Etsy access token from the environment or refresh flow.
 */
async function getAccessToken(): Promise<string> {
  const existingToken = getLiveEtsyToken();
  if (existingToken) {
    return existingToken;
  }
  return refreshEtsyToken();
}

/**
 * Parses a response body into text so error messages remain readable and actionable.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `Unable to read error body: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Performs an Etsy API request with a single retry on 401 so expired access tokens can recover.
 */
async function fetchEtsy(path: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${etsyApiBaseUrl}${path}`;

  const makeRequest = async (): Promise<Response> => {
    const headers = buildHeaders(await getAccessToken());
    if (options.headers) {
      const extraHeaders = new Headers(options.headers);
      extraHeaders.forEach((value, key) => headers.set(key, value));
    }

    return fetch(url, {
      ...options,
      headers,
    });
  };

  let response = await makeRequest();

  if (response.status === 401 && process.env.ETSY_REFRESH_TOKEN?.trim()) {
    await refreshEtsyToken();
    response = await makeRequest();
    if (response.status === 401) {
      throw new Error("Etsy authentication failed after token refresh - run npm run go-live to re-authenticate");
    }
  }

  return response;
}

/**
 * Searches active Etsy listings for a keyword so Jarvis can estimate demand and competition.
 */
export async function searchActiveListings(keyword: string, limit = 20): Promise<EtsySearchListing[]> {
  try {
    logger.action("Searching active Etsy listings", "start", { keyword, limit });
    const query = new URLSearchParams({
      keywords: keyword,
      limit: String(limit),
      sort_on: "score",
      sort_order: "down",
    });
    const response = await fetchEtsy(`/application/listings/active?${query.toString()}`, { method: "GET" });

    if (!response.ok) {
      throw new Error(`Etsy search failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as EtsyListResponse<EtsySearchListing>;
    logger.action("Fetched Etsy search results", "success", { keyword, count: payload.results.length });
    return payload.results;
  } catch (error) {
    logger.error("Etsy active listing search failed", error, { keyword, limit });
    throw new Error(`Etsy search failed for "${keyword}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Creates an Etsy draft listing using the configured shop credentials and a form-encoded payload.
 */
export async function createDraftListing(payload: EtsyDraftListingPayload): Promise<EtsyDraftListingResponse> {
  try {
    logger.action("Creating Etsy draft listing", "start", { title: payload.title });
    const shopId = getShopId();
    const taxonomyId = payload.taxonomyId ?? Number.parseInt(process.env.ETSY_DEFAULT_TAXONOMY_ID ?? "0", 10);
    const shippingProfileId = payload.shippingProfileId ?? Number.parseInt(process.env.ETSY_SHIPPING_PROFILE_ID ?? "0", 10);
    const readinessStateId = payload.readinessStateId ?? Number.parseInt(process.env.ETSY_READINESS_STATE_ID ?? "0", 10);
    const shopSectionId = payload.shopSectionId ?? process.env.ETSY_DEFAULT_SHOP_SECTION_ID?.trim() ?? "";

    if (!taxonomyId) {
      throw new Error("taxonomyId is required to create an Etsy draft listing.");
    }
    const formData = new URLSearchParams({
      quantity: String(payload.quantity ?? 999),
      title: payload.title,
      description: payload.description,
      price: payload.price.toFixed(2),
      who_made: payload.whoMade ?? "i_did",
      when_made: payload.whenMade ?? "made_to_order",
      taxonomy_id: String(taxonomyId),
      is_supply: payload.isSupply ? "true" : "false",
      type: payload.type ?? "physical",
      tags: payload.tags.join(","),
      item_weight: "0.5",
      item_weight_unit: "oz",
      item_length: "4.0",
      item_width: "4.0",
      item_height: "0.01",
      item_dimensions_unit: "in",
    });

    if (shippingProfileId) {
      formData.set("shipping_profile_id", String(shippingProfileId));
    }

    if (readinessStateId) {
      formData.set("readiness_state_id", String(readinessStateId));
    }

    if (shopSectionId) {
      formData.set("shop_section_id", String(shopSectionId));
    }

    const response = await fetchEtsy(`/application/shops/${shopId}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Etsy draft creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const result = (await response.json()) as EtsyDraftListingResponse;
    logger.action("Etsy draft listing created", "success", { listingId: result.listing_id });
    return result;
  } catch (error) {
    logger.error("Etsy draft listing creation failed", error, { title: payload.title });
    throw new Error(`Etsy draft creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Compatibility alias for callers that want a generic createListing name while still using the shared Etsy client path.
 */
export async function createListing(payload: EtsyDraftListingPayload): Promise<EtsyDraftListingResponse> {
  return createDraftListing(payload);
}

/**
 * Uploads a generated local image file to an Etsy listing so it can be activated later.
 */
export async function uploadListingImage(listingId: string | number, imagePath: string): Promise<void> {
  try {
    logger.action("Uploading Etsy listing image", "start", { listingId, imagePath });
    const shopId = getShopId();
    const imageBuffer = await readFile(imagePath);
    const formData = new FormData();
    const extension = extname(imagePath).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : "image/png";
    const file = new File([imageBuffer], basename(imagePath), { type: mimeType });
    formData.set("image", file);

    const response = await fetchEtsy(`/application/shops/${shopId}/listings/${listingId}/images`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Etsy image upload failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    logger.action("Uploaded Etsy listing image", "success", { listingId, imagePath });
  } catch (error) {
    logger.error("Etsy listing image upload failed", error, { listingId, imagePath });
    throw new Error(`Etsy image upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Marks an Etsy draft listing active once the listing has at least one uploaded image.
 */
export async function activateListing(listingId: string | number): Promise<EtsyPublishResult> {
  try {
    logger.action("Activating Etsy listing", "start", { listingId });
    const shopId = getShopId();
    const body = new URLSearchParams({ state: "active" });
    const response = await fetchEtsy(`/application/shops/${shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Etsy listing activation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as { url?: string };
    const listingUrl = payload.url ?? `https://www.etsy.com/listing/${listingId}`;
    logger.action("Activated Etsy listing", "success", { listingId, listingUrl });
    return {
      success: true,
      etsyListingId: String(listingId),
      listingUrl,
    };
  } catch (error) {
    logger.error("Etsy listing activation failed", error, { listingId });
    throw new Error(`Etsy listing activation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Returns the shop shipping profiles so physical listings can choose a valid fulfillment profile before publish.
 */
export async function getShippingProfiles(): Promise<EtsyShippingProfile[]> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}/shipping-profiles`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Etsy shipping profile lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as { results?: EtsyShippingProfile[] };
  return payload.results ?? [];
}

/**
 * Fetches the authenticated shop document so health checks can verify Etsy reachability with the normal token-refresh path.
 */
export async function getShopInfo(): Promise<Record<string, unknown>> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Etsy shop lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Retrieves listing-level metrics and receipt-level sales data for analytics reporting.
 */
export async function getListingMetrics(etsyListingId: string): Promise<EtsyListingMetrics> {
  try {
    logger.action("Fetching Etsy listing metrics", "start", { etsyListingId });
    const shopId = getShopId();
    const listingResponse = await fetchEtsy(`/application/shops/${shopId}/listings/${etsyListingId}`, { method: "GET" });

    if (!listingResponse.ok) {
      throw new Error(`Etsy listing lookup failed: ${listingResponse.status} ${listingResponse.statusText} - ${await readErrorBody(listingResponse)}`);
    }

    const listingPayload = (await listingResponse.json()) as {
      views?: number;
      num_favorers?: number;
    };

    const receiptsResponse = await fetchEtsy(`/application/shops/${shopId}/receipts?limit=100`, { method: "GET" });
    if (!receiptsResponse.ok) {
      throw new Error(`Etsy receipts lookup failed: ${receiptsResponse.status} ${receiptsResponse.statusText} - ${await readErrorBody(receiptsResponse)}`);
    }

    const receiptsPayload = (await receiptsResponse.json()) as EtsyListResponse<EtsyReceiptRecord>;
    let sales = 0;
    let revenue = 0;

    for (const receipt of receiptsPayload.results) {
      for (const transaction of receipt.transactions ?? []) {
        if (String(transaction.listing_id ?? "") !== etsyListingId) {
          continue;
        }

        const quantity = Number(transaction.quantity ?? 0);
        const price = Number(transaction.price ?? 0);
        sales += quantity;
        revenue += price * quantity;
      }
    }

    const metrics: EtsyListingMetrics = {
      views: Number(listingPayload.views ?? 0),
      favorites: Number(listingPayload.num_favorers ?? 0),
      sales,
      revenue,
    };

    logger.action("Fetched Etsy listing metrics", "success", { etsyListingId, metrics });
    return metrics;
  } catch (error) {
    logger.error("Etsy listing metrics lookup failed", error, { etsyListingId });
    throw new Error(`Etsy metrics lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Returns the authenticated Etsy user document using the explicit numeric user ID configured in the environment.
 */
export async function getAuthenticatedUser(): Promise<Record<string, unknown>> {
  const userId = getUserId();
  const response = await fetchEtsy(`/application/users/${userId}`, { method: "GET" });

  if (!response.ok) {
    throw new Error(`Etsy user lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Lists recent Etsy shop receipts so downstream fulfillment logic can detect new paid orders.
 */
export async function listShopReceipts(limit = 50): Promise<EtsyReceiptRecord[]> {
  try {
    logger.action("Fetching Etsy shop receipts", "start", { limit });
    const shopId = getShopId();
    const query = new URLSearchParams({
      limit: String(limit),
      was_paid: "true",
      was_shipped: "false",
    });

    const response = await fetchEtsy(`/application/shops/${shopId}/receipts?${query.toString()}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Etsy receipts lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as EtsyListResponse<EtsyReceiptRecord>;
    logger.action("Fetched Etsy shop receipts", "success", { count: payload.results.length });
    return payload.results;
  } catch (error) {
    logger.error("Etsy shop receipts lookup failed", error, { limit });
    throw new Error(`Etsy shop receipts lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pushes shipment tracking back to Etsy after a fulfillment provider assigns a tracking number.
 */
export async function updateReceiptTracking(
  receiptId: string | number,
  trackingCode: string,
  carrierName = "Other",
  sendBcc = true,
): Promise<void> {
  try {
    logger.action("Updating Etsy receipt tracking", "start", { receiptId, trackingCode, carrierName });
    const shopId = getShopId();
    const response = await fetchEtsy(`/application/shops/${shopId}/receipts/${receiptId}/tracking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        tracking_code: trackingCode,
        carrier_name: carrierName,
        send_bcc: sendBcc ? "true" : "false",
      }),
    });

    if (!response.ok) {
      throw new Error(`Etsy tracking update failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    logger.action("Updated Etsy receipt tracking", "success", { receiptId, trackingCode });
  } catch (error) {
    logger.error("Etsy receipt tracking update failed", error, { receiptId, trackingCode });
    throw new Error(`Etsy tracking update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Updates the core shop copy fields that Etsy exposes through the shop-management endpoint.
 */
export async function updateShopCore(payload: EtsyShopUpdatePayload): Promise<EtsyShopUpdateResult> {
  const shopId = getShopId();
  const coreBody = new URLSearchParams();
  const policyBody = new URLSearchParams();
  const coreApplied: string[] = [];

  if (payload.title) {
    coreBody.set("title", payload.title);
    coreApplied.push("title");
  }
  if (payload.announcement) {
    coreBody.set("announcement", payload.announcement);
    coreApplied.push("announcement");
  }
  if (payload.saleMessage) {
    coreBody.set("sale_message", payload.saleMessage);
    coreApplied.push("sale_message");
  }

  if (payload.policyWelcome) policyBody.set("policy_welcome", payload.policyWelcome);
  if (payload.policyPayment) policyBody.set("policy_payment", payload.policyPayment);
  if (payload.policyShipping) policyBody.set("policy_shipping", payload.policyShipping);
  if (payload.policyRefunds) policyBody.set("policy_refunds", payload.policyRefunds);
  if (payload.policyAdditional) policyBody.set("policy_additional", payload.policyAdditional);

  if (coreBody.size > 0) {
    const response = await fetchEtsy(`/application/shops/${shopId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: coreBody,
    });

    if (!response.ok) {
      throw new Error(`Etsy shop update failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }
  }

  if (policyBody.size === 0) {
    return {
      coreApplied,
      policiesApplied: false,
      policiesManualRequired: false,
    };
  }

  try {
    const policyResponse = await fetchEtsy(`/application/shops/${shopId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: policyBody,
    });

    if (!policyResponse.ok) {
      const policyErrorMessage = `Etsy shop policy update failed: ${policyResponse.status} ${policyResponse.statusText} - ${await readErrorBody(policyResponse)}`;
      logger.warn(policyErrorMessage, { shopId });
      return {
        coreApplied,
        policiesApplied: false,
        policiesManualRequired: true,
        policyErrorMessage,
      };
    }
  } catch (error) {
    const policyErrorMessage = `Etsy shop policy update failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn(policyErrorMessage, { shopId });
    return {
      coreApplied,
      policiesApplied: false,
      policiesManualRequired: true,
      policyErrorMessage,
    };
  }

  return {
    coreApplied,
    policiesApplied: true,
    policiesManualRequired: false,
  };
}

/**
 * Lists current shop sections so setup scripts can avoid creating duplicates.
 */
export async function listShopSections(): Promise<EtsyShopSection[]> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}/sections`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Etsy shop sections lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as EtsyListResponse<EtsyShopSection>;
  return payload.results;
}

/**
 * Creates one Etsy shop section and returns the server-assigned section identifier.
 */
export async function createShopSection(title: string): Promise<EtsyShopSection> {
  const shopId = getShopId();
  let normalizedTitle = title;

  if (normalizedTitle.length > 24) {
    normalizedTitle = normalizedTitle.substring(0, 24).trim();
    logger.warn("Shop section title exceeded Etsy limit and was truncated.", {
      originalTitle: title,
      truncatedTitle: normalizedTitle,
    });
  }

  const response = await fetchEtsy(`/application/shops/${shopId}/sections`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ title: normalizedTitle }),
  });

  if (!response.ok) {
    throw new Error(`Etsy shop section creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }

  return (await response.json()) as EtsyShopSection;
}

/**
 * Assigns a published listing to a shop section so catalog organization stays automatic.
 */
export async function updateListingSection(listingId: string | number, sectionId: string | number): Promise<void> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}/listings/${listingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      shop_section_id: String(sectionId),
    }),
  });

  if (!response.ok) {
    throw new Error(`Etsy listing section update failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }
}

/**
 * Updates a live Etsy listing's tags so low-traffic listings can test a refreshed keyword mix without recreating the listing.
 */
export async function updateListingTags(listingId: string | number, tags: string[]): Promise<void> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}/listings/${listingId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      tags: tags.join(","),
    }),
  });

  if (!response.ok) {
    throw new Error(`Etsy listing tag update failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }
}

/**
 * Attempts to update the shop about story when the endpoint is supported; callers can catch 404 and fall back to manual entry.
 */
export async function updateShopAboutStory(story: string): Promise<void> {
  const shopId = getShopId();
  const response = await fetchEtsy(`/application/shops/${shopId}/about`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ story }),
  });

  if (!response.ok) {
    throw new Error(`Etsy shop about update failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
  }
}

/**
 * Uploads the shop banner image to Etsy so the storefront visual identity can be applied automatically in live mode.
 */
export async function uploadShopBannerImage(imagePath: string): Promise<EtsyImageUploadResult> {
  const shopId = getShopId();
  const imageBuffer = await readFile(imagePath);
  const formData = new FormData();
  formData.set("image", new File([imageBuffer], basename(imagePath), { type: "image/png" }));

  const response = await fetchEtsy(`/application/shops/${shopId}/banner-image`, {
    method: "POST",
    body: formData,
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Etsy banner upload failed: ${response.status} ${response.statusText} - ${responseBody}`);
  }

  return {
    success: true,
    responseBody,
  };
}

/**
 * Uploads the shop icon image to Etsy so the profile mark can be applied automatically in live mode.
 */
export async function uploadShopIconImage(imagePath: string): Promise<EtsyImageUploadResult> {
  const shopId = getShopId();
  const imageBuffer = await readFile(imagePath);
  const formData = new FormData();
  formData.set("image", new File([imageBuffer], basename(imagePath), { type: "image/png" }));

  const response = await fetchEtsy(`/application/shops/${shopId}/icon-image`, {
    method: "POST",
    body: formData,
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Etsy icon upload failed: ${response.status} ${response.statusText} - ${responseBody}`);
  }

  return {
    success: true,
    responseBody,
  };
}
