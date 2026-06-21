import "dotenv/config";

import { pathToFileURL } from "node:url";

import { getListingByEtsyListingId, getPodProductByListingId, getRecentOrders, getConsecutiveShippingErrorCount, initializeDatabase, pausePublishing, upsertOrder } from "../lib/db.js";
import { auditLog } from "../lib/audit.js";
import { recordFailure } from "../lib/dead-letter.js";
import { postDiscordText } from "../lib/discord.js";
import { listShopReceipts, updateReceiptTracking, type EtsyReceiptRecord, type EtsyReceiptTransactionRecord } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { createPrintfulOrder, getPrintfulOrder, getSyncProductVariants } from "../lib/printful-client.js";
import { getPrintifyOrder } from "../lib/printify-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";

export interface OrderOrchestratorSummary {
  newOrders: number;
  trackingUpdates: number;
  failures: string[];
}

const logger = createLogger("order-orchestrator");

/**
 * Posts a plain-text Discord alert for fulfillment events when a webhook URL is configured.
 */
async function postDiscordAlert(message: string): Promise<void> {
  await postDiscordText("orders", message);
}

/**
 * Splits a buyer full name into first and last name pieces that POD providers require.
 */
function splitBuyerName(name: string | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? "Etsy Buyer").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "Etsy",
    lastName: parts.slice(1).join(" ") || "Buyer",
  };
}

/**
 * Creates the address payload shape Printify expects from an Etsy receipt record.
 */
function buildPrintifyAddress(receipt: EtsyReceiptRecord): {
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
} {
  const name = splitBuyerName(receipt.name);
  return {
    first_name: name.firstName,
    last_name: name.lastName,
    email: `${receipt.buyer_user_id ?? "buyer"}@etsy.local`,
    country: receipt.country_iso ?? "US",
    region: receipt.state,
    city: receipt.city ?? "Unknown",
    address1: receipt.first_line ?? "Unknown",
    address2: receipt.second_line,
    zip: receipt.zip ?? "00000",
  };
}

/**
 * Calculates listing-level profit for a line item using the stored POD base cost metadata.
 */
function calculateProfit(totalAmount: number, quantity: number, baseCost: number): number {
  return Number((totalAmount - baseCost * quantity).toFixed(2));
}

/**
 * Pulls a best-effort size/color hint from Etsy transaction variations for sync-variant matching.
 */
function extractVariantHints(transaction: EtsyReceiptTransactionRecord | undefined): { size: string | null; color: string | null } {
  const hints = { size: null as string | null, color: null as string | null };
  for (const variation of transaction?.variations ?? []) {
    const key = `${variation.property_name ?? variation.formatted_name ?? ""}`.toLowerCase();
    const value = `${variation.value ?? variation.formatted_value ?? ""}`.trim();
    if (!value) {
      continue;
    }

    if (!hints.size && key.includes("size")) {
      hints.size = value;
    }
    if (!hints.color && (key.includes("color") || key.includes("colour"))) {
      hints.color = value;
    }
  }

  return hints;
}

/**
 * Matches a buyer's size/color selection to one of the synced Printful variants, falling back to the first variant when Etsy did not expose options.
 */
async function resolvePrintfulSyncVariantId(syncProductId: string, transaction: EtsyReceiptTransactionRecord | undefined): Promise<number> {
  const syncVariants = await getSyncProductVariants(syncProductId);
  if (syncVariants.length === 0) {
    throw new Error(`Printful sync product ${syncProductId} does not have any synced variants.`);
  }

  const hints = extractVariantHints(transaction);
  const normalizedSize = hints.size?.toLowerCase() ?? null;
  const normalizedColor = hints.color?.toLowerCase() ?? null;

  const exactMatch = syncVariants.find((variant) => {
    const name = `${variant.name ?? ""}`.toLowerCase();
    const matchesSize = normalizedSize ? name.includes(normalizedSize) : true;
    const matchesColor = normalizedColor ? name.includes(normalizedColor) : true;
    return matchesSize && matchesColor;
  });

  const fallback = exactMatch ?? syncVariants[0];
  if (typeof fallback.id !== "number") {
    throw new Error(`Printful sync product ${syncProductId} returned a variant without a numeric ID.`);
  }

  return fallback.id;
}

/**
 * Creates a Printful fulfillment order when one approved Etsy listing already has a linked sync product.
 */
async function createProviderOrder(receipt: EtsyReceiptRecord): Promise<{
  provider: "printful" | "manual";
  providerOrderId?: string;
  trackingNumber?: string;
  carrier?: string;
  profitAmount: number;
  listingTitle: string;
}> {
  const transaction = receipt.transactions?.[0];
  if (!transaction?.listing_id) {
    throw new Error(`Receipt ${receipt.receipt_id} did not include a listing ID to match against local products.`);
  }

  const listing = getListingByEtsyListingId(String(transaction.listing_id));
  if (!listing) {
    throw new Error(`No local listing matched Etsy listing ${transaction.listing_id}.`);
  }

  const podProduct = getPodProductByListingId(listing.id);
  const quantity = Number(transaction.quantity ?? 1);
  const totalAmount = Number(receipt.grandtotal ?? transaction.price ?? 0);
  const listingTitle = transaction.title ?? listing.title;
  const profitAmount = calculateProfit(totalAmount, quantity, podProduct?.base_cost ?? 0);

  if (!podProduct?.printful_product_id) {
    const orderUrl = `https://www.etsy.com/your/orders/sold?order_id=${receipt.receipt_id}`;
    await postDiscordAlert(
      `MANUAL FULFILLMENT NEEDED:\n${listingTitle} - no POD mapping. Etsy order: ${orderUrl}`,
    );
    return {
      provider: "manual",
      profitAmount,
      listingTitle,
    };
  }

  const syncVariantId = await resolvePrintfulSyncVariantId(podProduct.printful_product_id, transaction);
  const printfulOrder = await createPrintfulOrder({
    externalId: String(receipt.receipt_id),
    recipient: {
      name: receipt.name ?? "Etsy Buyer",
      address1: receipt.first_line ?? "Unknown",
      address2: receipt.second_line,
      city: receipt.city ?? "Unknown",
      state_code: receipt.state,
      country_code: receipt.country_iso ?? "US",
      zip: receipt.zip ?? "00000",
      email: `${receipt.buyer_user_id ?? "buyer"}@etsy.local`,
    },
    items: [
      {
        sync_variant_id: syncVariantId,
        quantity,
      },
    ],
  });

  await postDiscordAlert(
    `ORDER FULFILLED: ${listingTitle}\nPrintful order ${printfulOrder.id} created. Ships to ${receipt.city ?? "Unknown city"}`,
  );
  auditLog("fulfill", "jarvis", {
    provider: "printful",
    receiptId: receipt.receipt_id,
    printfulOrderId: printfulOrder.id,
    city: receipt.city ?? "Unknown city",
  }, listing.id, listing.design_id ?? undefined);

  return {
    provider: "printful",
    providerOrderId: String(printfulOrder.id),
    trackingNumber: printfulOrder.tracking_number,
    carrier: printfulOrder.carrier,
    profitAmount,
    listingTitle,
  };
}

/**
 * Polls open provider orders and pushes new tracking codes back to Etsy when they appear.
 */
async function refreshOpenOrderStatuses(): Promise<number> {
  const recentOrders = getRecentOrders(50).filter((order) => order.printful_order_id && !order.tracking_number);
  let trackingUpdates = 0;

  for (const order of recentOrders) {
    try {
      if (order.provider === "printful" && order.printful_order_id) {
        const latest = await getPrintfulOrder(order.printful_order_id);
        if (latest.tracking_number && latest.tracking_number !== order.tracking_number) {
          await updateReceiptTracking(order.etsy_receipt_id, latest.tracking_number, latest.carrier ?? "Other", true);
          upsertOrder({
            etsyReceiptId: order.etsy_receipt_id,
            printfulOrderId: order.printful_order_id,
            buyerId: order.buyer_id,
            buyerName: order.buyer_name,
            listingTitle: order.listing_title,
            totalAmount: order.total_amount,
            profitAmount: order.profit_amount,
            status: "shipped",
            trackingNumber: latest.tracking_number,
            carrier: latest.carrier ?? null,
            provider: "printful",
            fulfilledAt: latest.tracking_number ? new Date().toISOString() : null,
          });
          await postDiscordAlert(
            `SHIPPED: ${order.listing_title ?? "Unknown listing"} -> ${latest.tracking_number} via ${latest.carrier ?? "Other"}`,
          );
          auditLog("tracking_updated", "jarvis", {
            provider: "printful",
            receiptId: order.etsy_receipt_id,
            printfulOrderId: order.printful_order_id,
            trackingNumber: latest.tracking_number,
            carrier: latest.carrier ?? "Other",
          });
          trackingUpdates += 1;
        }
      } else if (order.provider === "printify" && order.printify_order_id) {
        const latest = await getPrintifyOrder(order.printify_order_id);
        if (latest.tracking_number && latest.tracking_number !== order.tracking_number) {
          await updateReceiptTracking(order.etsy_receipt_id, latest.tracking_number);
          upsertOrder({
            etsyReceiptId: order.etsy_receipt_id,
            printifyOrderId: order.printify_order_id,
            buyerId: order.buyer_id,
            buyerName: order.buyer_name,
            listingTitle: order.listing_title,
            totalAmount: order.total_amount,
            profitAmount: order.profit_amount,
            status: "shipped",
            trackingNumber: latest.tracking_number,
            provider: "printify",
            fulfilledAt: latest.tracking_number ? new Date().toISOString() : null,
          });
          trackingUpdates += 1;
        }
      }
    } catch (error) {
      recordFailure(
        "fulfill",
        error instanceof Error ? error.message : String(error),
        {
          receiptId: order.etsy_receipt_id,
          provider: order.provider,
          printfulOrderId: order.printful_order_id,
          printifyOrderId: order.printify_order_id,
          source: "order-orchestrator:refresh",
        },
      );
      logger.error("Failed to refresh an open provider order", error, { receiptId: order.etsy_receipt_id });
    }
  }

  return trackingUpdates;
}

/**
 * Runs the fulfillment loop for new Etsy receipts and refreshes tracking on existing provider orders.
 */
export async function runOrderOrchestrator(): Promise<OrderOrchestratorSummary> {
  if (isDryRunEnabled()) {
    const summary: OrderOrchestratorSummary = {
      newOrders: 0,
      trackingUpdates: 0,
      failures: [],
    };
    logger.action("Dry-run order orchestrator completed", "skip", summary);
    return summary;
  }

  initializeDatabase();
  const summary: OrderOrchestratorSummary = {
    newOrders: 0,
    trackingUpdates: 0,
    failures: [],
  };

  logger.action("Starting order orchestrator", "start");
  const receipts = await listShopReceipts(25);

  for (const receipt of receipts) {
    const existingOrder = getRecentOrders(100).find((order) => order.etsy_receipt_id === String(receipt.receipt_id));
    if (existingOrder) {
      continue;
    }

    try {
      const created = await createProviderOrder(receipt);
      upsertOrder({
        etsyReceiptId: String(receipt.receipt_id),
        printifyOrderId: null,
        printfulOrderId: created.provider === "printful" ? created.providerOrderId : null,
        buyerId: receipt.buyer_user_id ? String(receipt.buyer_user_id) : null,
        buyerName: receipt.name ?? "Etsy Buyer",
        listingTitle: created.listingTitle,
        totalAmount: Number(receipt.grandtotal ?? 0),
        profitAmount: created.profitAmount,
        status: created.provider === "manual" ? "pending" : "fulfilled",
        trackingNumber: created.trackingNumber ?? null,
        carrier: created.carrier ?? null,
        provider: created.provider,
      });
      auditLog("order_received", "system", {
        receiptId: receipt.receipt_id,
        provider: created.provider,
        totalAmount: Number(receipt.grandtotal ?? 0),
      });
      summary.newOrders += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertOrder({
        etsyReceiptId: String(receipt.receipt_id),
        buyerId: receipt.buyer_user_id ? String(receipt.buyer_user_id) : null,
        buyerName: receipt.name ?? "Etsy Buyer",
        listingTitle: receipt.transactions?.[0]?.title ?? null,
        totalAmount: Number(receipt.grandtotal ?? 0),
        profitAmount: 0,
        status: "failed",
        provider: "printful",
        errorDetail: message,
        shippingErrorCount: message.toLowerCase().includes("shipping") ? 1 : 0,
      });
      recordFailure(
        "fulfill",
        message,
        {
          receiptId: receipt.receipt_id,
          buyerId: receipt.buyer_user_id ?? null,
          buyerName: receipt.name ?? "Etsy Buyer",
          listingTitle: receipt.transactions?.[0]?.title ?? null,
          source: "order-orchestrator:create",
        },
      );
      summary.failures.push(message);
      logger.error("Failed to create provider order for Etsy receipt", error, { receiptId: receipt.receipt_id });
    }
  }

  summary.trackingUpdates = await refreshOpenOrderStatuses();
  if (getConsecutiveShippingErrorCount(3) >= 3) {
    pausePublishing("Publishing auto-paused after three consecutive shipping-related provider errors.");
  }

  logger.action("Completed order orchestrator", "success", summary);
  return summary;
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone order-orchestrator entry point and prints the run summary as JSON.
 */
async function main(): Promise<void> {
  try {
    const summary = await runOrderOrchestrator();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    recordFailure(
      "fulfill",
      error instanceof Error ? error.message : String(error),
      {
        source: "order-orchestrator:main",
      },
    );
    logger.error("Standalone order-orchestrator execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
