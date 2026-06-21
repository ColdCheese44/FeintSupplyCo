import "dotenv/config";

import fs from "node:fs";

import { createLogger } from "./logger.js";

export interface PrintifyProductVariantInput {
  id: number;
  price: number;
  is_enabled: boolean;
}

export interface PrintifyProductCreateInput {
  title: string;
  description: string;
  blueprintId: number;
  printProviderId: number;
  variants: PrintifyProductVariantInput[];
  imageId: string;
  tags?: string[];
}

export interface PrintifyProductResult {
  id: string;
  title: string;
  visible?: boolean;
  external?: {
    id?: string | number;
    handle?: string;
  };
}

export interface PrintifyOrderCreateInput {
  lineItems: Array<{
    product_id: string;
    variant_id: number;
    quantity: number;
  }>;
  addressTo: {
    first_name: string;
    last_name: string;
    email: string;
    country: string;
    region?: string;
    city: string;
    address1: string;
    address2?: string;
    zip: string;
    phone?: string;
  };
  externalId: string;
}

export interface PrintifyOrderResult {
  id: string;
  status?: string;
  tracking_number?: string;
}

const logger = createLogger("printify-client");
const printifyApiBaseUrl = "https://api.printify.com/v1";

/**
 * Returns the configured Printify token and fails fast when it is missing.
 */
function getPrintifyToken(): string {
  const token = process.env.PRINTIFY_API_TOKEN?.trim();
  if (!token) {
    throw new Error("PRINTIFY_API_TOKEN is missing. Add it to the project .env file before using Printify.");
  }
  return token;
}

/**
 * Returns the configured Printify shop ID and fails fast when it is missing.
 */
function getPrintifyShopId(): string {
  const shopId = process.env.PRINTIFY_SHOP_ID?.trim();
  if (!shopId) {
    throw new Error("PRINTIFY_SHOP_ID is missing. Add it to the project .env file before using Printify.");
  }
  return shopId;
}

/**
 * Reads a response body into text so provider errors remain actionable in logs and retries.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `Unable to read Printify error body: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Performs an authenticated Printify API request with normalized headers.
 */
async function printifyRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getPrintifyToken()}`);
  headers.set("Accept", "application/json");

  return fetch(`${printifyApiBaseUrl}${path}`, {
    ...init,
    headers,
  });
}

/**
 * Uploads a local design asset to Printify as base64 so expiring provider URLs never block publishing.
 */
export async function uploadPrintifyImage(localImagePath: string, fileName: string): Promise<string> {
  try {
    logger.action("Uploading image to Printify", "start", { localImagePath, fileName });
    const fileBuffer = await fs.promises.readFile(localImagePath);
    const base64Contents = fileBuffer.toString("base64");

    const response = await fetch("https://api.printify.com/v1/uploads/images.json", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getPrintifyToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_name: fileName,
        contents: base64Contents,
      }),
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await readErrorBody(response);
      }
      throw new Error(`Printify image upload failed: ${response.status} ${response.statusText} - ${JSON.stringify(body)}`);
    }

    const result = (await response.json()) as { id: string };
    logger.action("Uploaded image to Printify", "success", { imageId: result.id });
    return result.id;
  } catch (error) {
    logger.error("Printify image upload failed", error, { localImagePath, fileName });
    throw new Error(`Printify image upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Creates a Printify product connected to the configured shop using the provided design and variants.
 */
export async function createPrintifyProduct(input: PrintifyProductCreateInput): Promise<PrintifyProductResult> {
  try {
    logger.action("Creating Printify product", "start", { title: input.title, blueprintId: input.blueprintId });
    const shopId = getPrintifyShopId();
    const response = await printifyRequest(`/shops/${shopId}/products.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        blueprint_id: input.blueprintId,
        print_provider_id: input.printProviderId,
        variants: input.variants.map((variant) => ({
          id: variant.id,
          price: variant.price,
          is_enabled: variant.is_enabled,
        })),
        print_areas: [
          {
            variant_ids: input.variants.map((variant) => variant.id),
            placeholders: [
              {
                position: "front",
                images: [
                  {
                    id: input.imageId,
                    x: 0.5,
                    y: 0.5,
                    scale: 1,
                    angle: 0,
                  },
                ],
              },
            ],
          },
        ],
        tags: input.tags ?? [],
      }),
    });

    if (!response.ok) {
      throw new Error(`Printify product creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as PrintifyProductResult;
    logger.action("Created Printify product", "success", { productId: payload.id, title: payload.title });
    return payload;
  } catch (error) {
    logger.error("Printify product creation failed", error, { title: input.title });
    throw new Error(`Printify product creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Publishes a Printify product to the connected Etsy shop using the standard publish toggles.
 */
export async function publishPrintifyProduct(productId: string): Promise<void> {
  try {
    logger.action("Publishing Printify product", "start", { productId });
    const shopId = getPrintifyShopId();
    const response = await printifyRequest(`/shops/${shopId}/products/${productId}/publish.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: true,
        description: true,
        images: true,
        variants: true,
        tags: true,
        keyFeatures: true,
        shipping_template: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Printify product publish failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    logger.action("Published Printify product", "success", { productId });
  } catch (error) {
    logger.error("Printify product publish failed", error, { productId });
    throw new Error(`Printify product publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetches a Printify product so downstream logic can inspect sync metadata such as external marketplace IDs.
 */
export async function getPrintifyProduct(productId: string): Promise<PrintifyProductResult> {
  try {
    logger.action("Fetching Printify product", "start", { productId });
    const shopId = getPrintifyShopId();
    const response = await printifyRequest(`/shops/${shopId}/products/${productId}.json`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Printify product lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as PrintifyProductResult;
    logger.action("Fetched Printify product", "success", { productId });
    return payload;
  } catch (error) {
    logger.error("Printify product lookup failed", error, { productId });
    throw new Error(`Printify product lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Creates a Printify fulfillment order for a buyer address after an Etsy receipt arrives.
 */
export async function createPrintifyOrder(input: PrintifyOrderCreateInput): Promise<PrintifyOrderResult> {
  try {
    logger.action("Creating Printify order", "start", { externalId: input.externalId });
    const shopId = getPrintifyShopId();
    const response = await printifyRequest(`/shops/${shopId}/orders.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: input.externalId,
        line_items: input.lineItems,
        address_to: input.addressTo,
      }),
    });

    if (!response.ok) {
      throw new Error(`Printify order creation failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as PrintifyOrderResult;
    logger.action("Created Printify order", "success", { orderId: payload.id, externalId: input.externalId });
    return payload;
  } catch (error) {
    logger.error("Printify order creation failed", error, { externalId: input.externalId });
    throw new Error(`Printify order creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetches the current Printify order status so fulfillment polling can sync tracking details back to Etsy.
 */
export async function getPrintifyOrder(orderId: string): Promise<PrintifyOrderResult> {
  try {
    logger.action("Fetching Printify order status", "start", { orderId });
    const shopId = getPrintifyShopId();
    const response = await printifyRequest(`/shops/${shopId}/orders/${orderId}.json`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Printify order lookup failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`);
    }

    const payload = (await response.json()) as PrintifyOrderResult;
    logger.action("Fetched Printify order status", "success", { orderId, status: payload.status });
    return payload;
  } catch (error) {
    logger.error("Printify order lookup failed", error, { orderId });
    throw new Error(`Printify order lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
