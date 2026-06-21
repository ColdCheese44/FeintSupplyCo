import "dotenv/config";

import Database from "better-sqlite3";
import express from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  getDesignById,
  findShopSectionByTitle,
  getListingById,
  getPendingApprovalListings,
  getPodProductByListingId,
  initializeDatabase,
  markListingPublished,
  resolveProjectPath,
  updateDesignAssets,
  updateListingPrintfulProductId,
  updateListingStatus,
  upsertPodProduct,
} from "../lib/db.js";
import { auditLog } from "../lib/audit.js";
import { createLinkedPrintfulSyncProduct, generateMockup, supportsPrintfulSync } from "../lib/printful-client.js";
import { refreshEtsyToken } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { ENAMEL_PIN_FULFILLMENT_NOTE, normalizeProductType } from "../lib/product-types.js";
import { publishListing } from "../skills/etsy-publish.js";
import { publishPodProduct } from "../skills/pod-publisher.js";
import { publishStickerDirect } from "../scripts/generate-sticker-pack.js";

const logger = createLogger("dashboard-server");
const app = express();
const port = Math.max(1, Math.min(65_535, Number.parseInt(process.env.DASHBOARD_PORT ?? "4200", 10) || 4200));
const host = process.env.DASHBOARD_HOST?.trim() || "127.0.0.1";
const databasePath = resolveProjectPath(process.env.DB_PATH?.trim() || "./data/jarvis.db");
const dashboardPath = resolveProjectPath("monitor/dashboard.html");
const heartbeatStatePath = resolveProjectPath("data/heartbeat-last-run.txt");

app.use(express.json());
initializeDatabase();

interface CostCategoryRow {
  category: string;
  spent: number;
  allocated: number;
  percent: number;
}

interface PendingApprovalRow {
  id: number;
  title: string;
  description: string;
  tags: string;
  price: number;
  niche: string;
  product_type: string;
  theme: string | null;
  created_at: string;
  local_design_path: string | null;
  image_url: string | null;
  status: string;
}

interface OrderDashboardRow {
  id: number;
  listing_title: string | null;
  buyer_name: string | null;
  status: string;
  printful_order_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  created_at: string;
  total_amount: number;
}

/**
 * Reads a numeric environment value while preserving a safe fallback.
 */
function readNumber(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parses optional JSON metadata safely so dashboard actions can inspect listing hints without crashing.
 */
function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Opens the Jarvis SQLite database in read-only mode when it exists.
 */
function openReadonlyDatabase(): Database.Database | null {
  if (!existsSync(databasePath)) {
    return null;
  }

  return new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
}

/**
 * Executes one read-only query block and falls back gracefully when the DB or one table is unavailable.
 */
function withReadonlyDatabase<T>(label: string, fallback: T, fn: (db: Database.Database) => T): T {
  const db = openReadonlyDatabase();
  if (!db) {
    return fallback;
  }

  try {
    return fn(db);
  } catch (error) {
    logger.warn(`Dashboard query failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  } finally {
    db.close();
  }
}

/**
 * Reads the last heartbeat timestamp from disk for the overview card.
 */
function readLastHeartbeatTimestamp(): string | null {
  if (!existsSync(heartbeatStatePath)) {
    return null;
  }

  try {
    const value = readFileSync(heartbeatStatePath, "utf8").trim();
    return value || null;
  } catch (error) {
    logger.warn(`Unable to read heartbeat timestamp file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Returns the budget allocations used by the dashboard progress bars.
 */
function getBudgetAllocations(): Record<string, number> {
  const seedBudget = readNumber(process.env.SEED_BUDGET_USD, 100);
  return {
    listing_fee: seedBudget * readNumber(process.env.BUDGET_LISTING_FEES_ALLOCATION, 0.30),
    image_gen: seedBudget * readNumber(process.env.BUDGET_IMAGE_GEN_ALLOCATION, 0.20),
    llm_copy: seedBudget * readNumber(process.env.BUDGET_LLM_COPY_ALLOCATION, 0.15),
    marketing: seedBudget * readNumber(process.env.BUDGET_MARKETING_ALLOCATION, 0.15),
    reserve: seedBudget * readNumber(process.env.BUDGET_RESERVE_ALLOCATION, 0.20),
  };
}

/**
 * Loads the top-level dashboard metrics for the KPI cards and header state.
 */
function loadOverview(): Record<string, unknown> {
  const seedBudget = readNumber(process.env.SEED_BUDGET_USD, 100);
  return withReadonlyDatabase("overview", {
    total_listings: 0,
    published_listings: 0,
    total_designs: 0,
    total_orders: 0,
    total_revenue: 0,
    operator_earnings: 0,
    seed_budget: seedBudget,
    total_spent: 0,
    remaining_budget: seedBudget,
    last_heartbeat: readLastHeartbeatTimestamp(),
    active_niches: [],
    pending_approval_count: 0,
  }, (db) => {
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM listings) AS total_listings,
        (SELECT COUNT(*) FROM listings WHERE status = 'published' AND etsy_listing_id IS NOT NULL) AS published_listings,
        (SELECT COUNT(*) FROM designs) AS total_designs,
        (SELECT COUNT(*) FROM orders) AS total_orders,
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders) AS total_revenue,
        (SELECT COALESCE(SUM(amount_usd), 0) FROM budget_ledger WHERE category = 'operator_earnings') AS operator_earnings,
        (SELECT COALESCE(SUM(amount_usd), 0) FROM budget_ledger WHERE category <> 'operator_earnings') AS total_spent,
        (SELECT COUNT(*) FROM listings WHERE status = 'pending_approval') AS pending_approval_count
    `).get() as {
      total_listings: number;
      published_listings: number;
      total_designs: number;
      total_orders: number;
      total_revenue: number;
      operator_earnings: number;
      total_spent: number;
      pending_approval_count: number;
    };

    const activeNiches = db.prepare(`
      SELECT name
      FROM niches
      WHERE active = 1
      ORDER BY priority ASC, name COLLATE NOCASE ASC
    `).all() as Array<{ name: string }>;

    const totalSpent = Number(totals.total_spent ?? 0);
    return {
      total_listings: Number(totals.total_listings ?? 0),
      published_listings: Number(totals.published_listings ?? 0),
      total_designs: Number(totals.total_designs ?? 0),
      total_orders: Number(totals.total_orders ?? 0),
      total_revenue: Number(totals.total_revenue ?? 0),
      operator_earnings: Number(totals.operator_earnings ?? 0),
      seed_budget: seedBudget,
      total_spent: totalSpent,
      remaining_budget: Number((seedBudget - totalSpent).toFixed(2)),
      last_heartbeat: readLastHeartbeatTimestamp(),
      active_niches: activeNiches.map((row) => row.name),
      pending_approval_count: Number(totals.pending_approval_count ?? 0),
    };
  });
}

/**
 * Loads the last 20 listings with their niche labels for the recent listings table.
 */
function loadListings(): Array<Record<string, unknown>> {
  return withReadonlyDatabase("listings", [], (db) => db.prepare(`
    SELECT
      listings.id,
      listings.title,
      COALESCE(niches.name, 'Unassigned') AS niche,
      COALESCE(listings.product_type, 'unknown') AS product_type,
      listings.status,
      listings.price,
      listings.created_at,
      listings.published_at,
      listings.etsy_listing_id
    FROM listings
    LEFT JOIN niches ON niches.id = listings.niche_id
    ORDER BY datetime(listings.created_at) DESC
    LIMIT 20
  `).all() as Array<Record<string, unknown>>);
}

/**
 * Loads the latest analytics row per listing and sorts by revenue so the dashboard can surface top performers.
 */
function loadAnalytics(): Array<Record<string, unknown>> {
  return withReadonlyDatabase("analytics", [], (db) => db.prepare(`
    SELECT
      COALESCE(listings.title, 'Untitled listing') AS title,
      analytics.views,
      analytics.favorites,
      analytics.sales,
      analytics.revenue
    FROM analytics
    INNER JOIN (
      SELECT listing_id, MAX(recorded_at) AS latest_recorded_at
      FROM analytics
      GROUP BY listing_id
    ) latest
      ON latest.listing_id = analytics.listing_id
     AND latest.latest_recorded_at = analytics.recorded_at
    LEFT JOIN listings ON listings.id = analytics.listing_id
    ORDER BY analytics.revenue DESC, analytics.sales DESC, analytics.views DESC
  `).all() as Array<Record<string, unknown>>);
}

/**
 * Loads grouped budget-ledger totals plus today's and seven-day spend windows for the cost panel.
 */
function loadCosts(): Record<string, unknown> {
  const allocations = getBudgetAllocations();
  return withReadonlyDatabase("costs", {
    categories: Object.entries(allocations).map(([category, allocated]) => ({
      category,
      spent: 0,
      allocated,
      percent: 0,
    })),
    today_spend: 0,
    seven_day_spend: 0,
  }, (db) => {
    const grouped = db.prepare(`
      SELECT category, COALESCE(SUM(amount_usd), 0) AS spent
      FROM budget_ledger
      GROUP BY category
    `).all() as Array<{ category: string; spent: number }>;

    const spentByCategory = new Map(grouped.map((row) => [row.category, Number(row.spent ?? 0)]));

    const todayRow = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM budget_ledger
      WHERE timestamp >= datetime('now', 'start of day')
        AND category <> 'operator_earnings'
    `).get() as { total: number };

    const sevenDayRow = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM budget_ledger
      WHERE timestamp >= datetime('now', '-7 days')
        AND category <> 'operator_earnings'
    `).get() as { total: number };

    const categories: CostCategoryRow[] = Object.entries(allocations).map(([category, allocated]) => {
      const spent = Number(spentByCategory.get(category) ?? 0);
      return {
        category,
        spent,
        allocated: Number(allocated.toFixed(2)),
        percent: allocated > 0 ? Math.min((spent / allocated) * 100, 999) : 0,
      };
    });

    return {
      categories,
      today_spend: Number(todayRow.total ?? 0),
      seven_day_spend: Number(sevenDayRow.total ?? 0),
    };
  });
}

/**
 * Loads niche-level listing counts and revenue so operators can see which themes are actually pulling weight.
 */
function loadNiches(): Array<Record<string, unknown>> {
  return withReadonlyDatabase("niches", [], (db) => db.prepare(`
    SELECT
      niches.id,
      niches.name,
      niches.priority,
      niches.active,
      COUNT(DISTINCT listings.id) AS listing_count,
      COALESCE(SUM(latest_analytics.revenue), 0) AS total_revenue
    FROM niches
    LEFT JOIN listings ON listings.niche_id = niches.id
    LEFT JOIN (
      SELECT analytics.listing_id, analytics.revenue
      FROM analytics
      INNER JOIN (
        SELECT listing_id, MAX(recorded_at) AS latest_recorded_at
        FROM analytics
        GROUP BY listing_id
      ) latest
        ON latest.listing_id = analytics.listing_id
       AND latest.latest_recorded_at = analytics.recorded_at
    ) latest_analytics ON latest_analytics.listing_id = listings.id
    GROUP BY niches.id, niches.name, niches.priority, niches.active
    ORDER BY total_revenue DESC, niches.priority ASC, niches.name COLLATE NOCASE ASC
  `).all() as Array<Record<string, unknown>>);
}

/**
 * Loads the most recent heartbeat summaries for the operational log table.
 */
function loadHeartbeatLog(): Array<Record<string, unknown>> {
  return withReadonlyDatabase("heartbeat", [], (db) => db.prepare(`
    SELECT
      id,
      started_at,
      finished_at,
      opportunities_considered,
      designs_generated,
      listings_published,
      total_cost_usd,
      error_count,
      errors,
      claude_calls,
      created_at
    FROM heartbeat_log
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 10
  `).all() as Array<Record<string, unknown>>);
}

/**
 * Loads the most recent IGM (passive bandwidth income) snapshot for the dashboard income panel.
 */
function loadIgm(): Record<string, unknown> {
  const fallback: Record<string, unknown> = {
    status: "never_run",
    running_apps: 0,
    total_apps: 0,
    earnings_usd: null,
    currency: "USD",
    containers: [],
    notes: ["IGM monitor has not run yet. Run `npm run igm:status`."],
    created_at: null,
  };

  return withReadonlyDatabase("igm", fallback, (db) => {
    const row = db.prepare(`
      SELECT id, status, running_apps, total_apps, earnings_usd, currency, detail, created_at
      FROM igm_snapshots
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `).get() as {
      status: string;
      running_apps: number;
      total_apps: number;
      earnings_usd: number | null;
      currency: string;
      detail: string | null;
      created_at: string;
    } | undefined;

    if (!row) {
      return fallback;
    }

    let containers: unknown[] = [];
    let notes: unknown[] = [];
    if (row.detail) {
      try {
        const parsed = JSON.parse(row.detail) as { containers?: unknown[]; notes?: unknown[] };
        containers = Array.isArray(parsed.containers) ? parsed.containers : [];
        notes = Array.isArray(parsed.notes) ? parsed.notes : [];
      } catch {
        containers = [];
        notes = [];
      }
    }

    return {
      status: row.status,
      running_apps: row.running_apps,
      total_apps: row.total_apps,
      earnings_usd: row.earnings_usd,
      currency: row.currency,
      containers,
      notes,
      created_at: row.created_at,
    };
  });
}

/**
 * Loads structured activity from all human, Jarvis, and system actors.
 */
function loadAuditLog(): Array<Record<string, unknown>> {
  return withReadonlyDatabase("audit-log", [], (db) => db.prepare(`
    SELECT id, action, actor, listing_id, design_id, details, created_at
    FROM audit_log
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 50
  `).all() as Array<Record<string, unknown>>);
}

/**
 * Loads the latest order rows for the dashboard order panel.
 */
function loadOrders(): OrderDashboardRow[] {
  return withReadonlyDatabase("orders", [], (db) => db.prepare(`
    SELECT
      id,
      listing_title,
      buyer_name,
      status,
      printful_order_id,
      tracking_number,
      carrier,
      created_at,
      total_amount
    FROM orders
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 20
  `).all() as OrderDashboardRow[]);
}

/**
 * Loads all listings waiting for manual approval so the dashboard can render the review queue.
 */
function loadPendingApprovals(): PendingApprovalRow[] {
  return getPendingApprovalListings(100).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    tags: row.tags,
    price: row.price,
    niche: row.niche_name ?? "Unassigned",
    product_type: row.product_type ?? "unknown",
    theme: row.theme,
    created_at: row.created_at,
    local_design_path: row.local_design_path ?? row.image_url,
    image_url: row.image_url,
    status: row.status,
  }));
}

/**
 * Resolves a stored design image path into an absolute local file path for image serving.
 */
function resolveDesignImagePath(candidatePath: string | null | undefined): string | null {
  if (!candidatePath) {
    return null;
  }

  const absolute = isAbsolute(candidatePath) ? candidatePath : resolve(resolveProjectPath("."), candidatePath);
  return existsSync(absolute) ? absolute : null;
}

/**
 * Normalizes a numeric value pulled from DB metadata without throwing on empty or malformed values.
 */
function readNumericCandidate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Reads an array of numeric IDs from loosely typed JSON metadata while skipping nullish values.
 */
function readNumericArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readNumericCandidate(entry))
    .filter((entry): entry is number => entry !== null);
}

/**
 * Parses stored mockup-path JSON into a normalized string array for publish-time image overrides.
 */
function readMockupPaths(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * Uses Printful's mockup generator for approved apparel listings and falls back to the raw design file if anything goes wrong.
 */
async function resolveApprovedApparelImagePath(listingId: number): Promise<string | null> {
  const listing = getListingById(listingId);
  if (!listing?.image_url) {
    return null;
  }

  const rawImagePath = resolveDesignImagePath(listing.image_url);
  if (!rawImagePath) {
    return null;
  }

  const podProduct = getPodProductByListingId(listingId);
  if (!podProduct || podProduct.provider !== "printful") {
    return rawImagePath;
  }

  const podMetadata = parseMetadata(podProduct.metadata);
  const printfulFileId = readNumericCandidate(podMetadata.printfulFileId);
  const blueprintId = readNumericCandidate(podProduct.blueprint_id ?? podMetadata.blueprintId);
  const variantId =
    readNumericCandidate(podProduct.variant_id)
    ?? readNumericArray(podMetadata.variantIds)[0]
    ?? null;

  if (!printfulFileId || !blueprintId || !variantId) {
    logger.warn("Printful mockup prerequisites were incomplete. Falling back to the raw apparel design.", {
      listingId,
      printfulFileId,
      blueprintId,
      variantId,
    });
    return rawImagePath;
  }

  try {
    const mockupUrl = await generateMockup(blueprintId, variantId, printfulFileId);
    const mockupPath = resolve(dirname(rawImagePath), "mockup.jpg");
    const response = await fetch(mockupUrl);
    if (!response.ok) {
      throw new Error(`Mockup download failed: ${response.status} ${response.statusText}`);
    }

    await mkdir(dirname(mockupPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(mockupPath, buffer);

    if (listing.design_id) {
      const design = getDesignById(listing.design_id);
      const existingMockupPaths = design?.mockup_paths
        ? (() => {
            try {
              const parsed = JSON.parse(design.mockup_paths) as unknown;
              return Array.isArray(parsed)
                ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
                : [];
            } catch {
              return [];
            }
          })()
        : [];

      const nextMockupPaths = Array.from(new Set([...existingMockupPaths, mockupPath]));
      updateDesignAssets(listing.design_id, {
        mockupPaths: nextMockupPaths,
        metadata: {
          ...parseMetadata(design?.metadata),
          latestMockupPath: mockupPath,
          latestMockupUrl: mockupUrl,
        },
      });
    }

    logger.info("Generated Printful apparel mockup for Etsy publish.", {
      listingId,
      mockupPath,
      mockupUrl,
      blueprintId,
      variantId,
      printfulFileId,
    });
    return mockupPath;
  } catch (error) {
    logger.warn("Printful mockup generation failed. Falling back to the raw apparel design.", {
      listingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return rawImagePath;
  }
}

/**
 * Resolves the best available listing image for an Etsy-only enamel pin, preferring a lifestyle mockup over the raw design.
 */
function resolveApprovedEnamelPinImagePath(listingId: number): string | null {
  const listing = getListingById(listingId);
  if (!listing) {
    return null;
  }

  if (listing.design_id) {
    const design = getDesignById(listing.design_id);
    for (const mockupPath of readMockupPaths(design?.mockup_paths)) {
      const resolved = resolveDesignImagePath(mockupPath);
      if (resolved) {
        return resolved;
      }
    }

    const designImagePath = resolveDesignImagePath(design?.image_path ?? null);
    if (designImagePath) {
      return designImagePath;
    }
  }

  return resolveDesignImagePath(listing.image_url);
}

/**
 * Ensures enamel-pin descriptions clearly communicate the manual made-to-order fulfillment path before Etsy publish.
 */
function buildEnamelPinDescription(description: string): string {
  return description.includes(ENAMEL_PIN_FULFILLMENT_NOTE)
    ? description
    : `${description}\n\n${ENAMEL_PIN_FULFILLMENT_NOTE}`;
}

/**
 * Resolves the local art path that should be sent to Printful for order-routing sync products.
 */
function resolveListingDesignPath(listingId: number): string | null {
  const listing = getListingById(listingId);
  if (!listing) {
    return null;
  }

  const designPath = listing.design_id ? getDesignById(listing.design_id)?.image_path ?? null : null;
  return resolveDesignImagePath(designPath ?? listing.image_url);
}

/**
 * Creates a Printful sync product linked to the Etsy listing ID so future marketplace orders can auto-import to fulfillment.
 */
async function ensurePrintfulSyncProductForListing(listingId: number, etsyListingId: string): Promise<void> {
  const listing = getListingById(listingId);
  if (!listing) {
    throw new Error(`Listing ${listingId} was not found while creating the Printful sync product.`);
  }
  const normalizedProductType = normalizeProductType(listing.product_type);
  if (!normalizedProductType || !supportsPrintfulSync(normalizedProductType)) {
    return;
  }

  const existingPodProduct = getPodProductByListingId(listingId);
  if (existingPodProduct?.provider === "printful" && existingPodProduct.printful_product_id) {
    updateListingPrintfulProductId(listingId, existingPodProduct.printful_product_id);
    return;
  }

  const localDesignPath = resolveListingDesignPath(listingId);
  if (!localDesignPath) {
    throw new Error(`Listing ${listingId} does not have a local design file available for Printful sync creation.`);
  }

  const sync = await createLinkedPrintfulSyncProduct({
    title: listing.title,
    productType: listing.product_type ?? "sticker",
    localImagePath: localDesignPath,
    externalId: etsyListingId,
    retailPrice: listing.price,
  });

  updateListingPrintfulProductId(listingId, sync.syncProductId);
  upsertPodProduct({
    listingId,
    printfulProductId: sync.syncProductId,
    blueprintId: sync.blueprintId,
    baseCost: 0,
    retailPrice: listing.price,
    profitMargin: 0,
    status: "published",
    provider: "printful",
    variantId: sync.syncVariantIds[0] ? String(sync.syncVariantIds[0]) : null,
    metadata: {
      printfulFileId: sync.fileId,
      printfulFileUrl: sync.fileUrl,
      thumbnailUrl: sync.thumbnailUrl,
      blueprintId: sync.blueprintId,
      variantIds: sync.catalogVariantIds,
      syncVariantIds: sync.syncVariantIds,
      externalId: etsyListingId,
      uploadedImagePath: localDesignPath,
      uploadProvider: "printful",
    },
  });

  logger.info(`Printful sync product created: ${sync.syncProductId}`, {
    listingId,
    etsyListingId,
    productType: listing.product_type,
    blueprintId: sync.blueprintId,
    syncVariantIds: sync.syncVariantIds,
  });
}

/**
 * Publishes one approved listing using the sticker direct path when needed, otherwise the existing POD and Etsy flow.
 */
async function approveListingById(listingId: number): Promise<{ success: true; etsyListingId: string }> {
  const listing = getListingById(listingId);
  if (!listing) {
    throw new Error(`Listing ${listingId} was not found.`);
  }

  const metadata = parseMetadata(listing.metadata);
  const isStickerCollection = metadata.stickerCollection === true;
  const normalizedProductType = normalizeProductType(listing.product_type);
  let etsyListingId: string;

  if (isStickerCollection) {
    const metadataDesignPath = typeof metadata.localDesignPath === "string" ? metadata.localDesignPath : null;
    const localDesignPath = resolveDesignImagePath(metadataDesignPath ?? listing.image_url);
    if (!localDesignPath) {
      throw new Error(`Listing ${listingId} does not have a local design image available for sticker publishing.`);
    }

    const sectionId = String(metadata.suggestedShopSectionId ?? findShopSectionByTitle("Stickers")?.etsy_section_id ?? "");
    if (!sectionId) {
      throw new Error("Stickers shop section is missing. Run shop setup before approving sticker listings.");
    }

    etsyListingId = await publishStickerDirect(localDesignPath, listing, sectionId, false);
    markListingPublished(listingId, etsyListingId);
  } else if (normalizedProductType === "enamel-pin") {
    const imagePathOverride = resolveApprovedEnamelPinImagePath(listingId);
    if (!imagePathOverride) {
      throw new Error(`Listing ${listingId} does not have an image or mockup available for enamel-pin publishing.`);
    }

    const publishResult = await publishListing(listingId, {
      imagePathOverride,
      descriptionOverride: buildEnamelPinDescription(listing.description),
    });
    if (!publishResult.success || !publishResult.etsy_listing_id) {
      throw new Error(publishResult.error ?? "Etsy publish failed during enamel-pin approval.");
    }

    etsyListingId = publishResult.etsy_listing_id;
  } else {
    const podResult = await publishPodProduct(listingId);
    if (!podResult.success) {
      throw new Error(podResult.error ?? "POD publish failed during approval.");
    }

    if (podResult.etsyListingId) {
      markListingPublished(listingId, podResult.etsyListingId);
      etsyListingId = podResult.etsyListingId;
    } else {
      const imagePathOverride = normalizedProductType === "t-shirt" || normalizedProductType === "hoodie"
        ? await resolveApprovedApparelImagePath(listingId)
        : undefined;
      const publishResult = await publishListing(
        listingId,
        imagePathOverride ? { imagePathOverride } : undefined,
      );
      if (!publishResult.success || !publishResult.etsy_listing_id) {
        throw new Error(publishResult.error ?? "Etsy publish failed during approval.");
      }

      etsyListingId = publishResult.etsy_listing_id;
    }
  }

  if (normalizedProductType !== "enamel-pin") {
    try {
      await ensurePrintfulSyncProductForListing(listingId, etsyListingId);
    } catch (error) {
      logger.warn("Printful sync product creation failed after Etsy publish. Listing remains live, but order routing may need manual attention.", {
        listingId,
        etsyListingId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { success: true, etsyListingId };
}

app.get("/", (_request, response) => {
  response.sendFile(dashboardPath);
});

app.get("/api/overview", (_request, response) => {
  response.json(loadOverview());
});

app.get("/api/pending", (_request, response) => {
  response.json(loadPendingApprovals());
});

app.get("/api/listings", (_request, response) => {
  response.json(loadListings());
});

app.get("/api/analytics", (_request, response) => {
  response.json(loadAnalytics());
});

app.get("/api/costs", (_request, response) => {
  response.json(loadCosts());
});

app.get("/api/niches", (_request, response) => {
  response.json(loadNiches());
});

app.get("/api/heartbeat", (_request, response) => {
  response.json(loadHeartbeatLog());
});

app.get("/api/orders", (_request, response) => {
  response.json(loadOrders());
});

app.get("/api/igm", (_request, response) => {
  response.json(loadIgm());
});

app.get("/api/audit", (_request, response) => {
  response.json(loadAuditLog());
});

// --- Ops controls: run a component or control the daemon from the dashboard ---
const isWindows = process.platform === "win32";
const opsProjectRoot = resolveProjectPath(".");

// Allowlist only — the :action param is a key lookup, never interpolated into a shell.
const opsNpmScripts: Record<string, string> = {
  heartbeat: "heartbeat",
  orderwatch: "orderwatch",
  "trend-mine": "trend-mine",
  costs: "costs",
  "igm-status": "igm:status",
  audit: "audit",
};

/**
 * Spawns an npm script detached so the dashboard request returns immediately; output goes to jarvis.log/Discord.
 */
function spawnNpmScript(scriptName: string): void {
  const child = spawn(isWindows ? "npm.cmd" : "npm", ["run", scriptName], {
    cwd: opsProjectRoot,
    detached: true,
    stdio: "ignore",
    shell: isWindows,
    windowsHide: true,
  });
  child.unref();
}

app.post("/api/ops/:action", (request, response) => {
  const action = String(request.params.action);

  try {
    if (opsNpmScripts[action]) {
      spawnNpmScript(opsNpmScripts[action]);
      auditLog("run_operation", "human", { action });
      response.json({ ok: true, message: `${action} started — watch your Discord channels and logs for results.` });
      return;
    }

    if (action === "daemon-start") {
      const runner = resolveProjectPath("scripts/run-daemon.cmd");
      const child = spawn(runner, [], { cwd: opsProjectRoot, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      auditLog("run_operation", "human", { action });
      response.json({ ok: true, message: "Daemon start requested (hidden)." });
      return;
    }

    if (action === "daemon-stop") {
      if (isWindows) {
        const psCommand = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*jarvis-daemon*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
        const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      }
      auditLog("run_operation", "human", { action });
      response.json({ ok: true, message: "Daemon stop requested." });
      return;
    }

    response.status(400).json({ ok: false, message: `Unknown action: ${action}` });
  } catch (error) {
    response.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/designs/:id/image", (request, response) => {
  const listingId = Number.parseInt(request.params.id, 10);
  if (!Number.isFinite(listingId)) {
    response.status(400).json({ error: "Invalid listing ID." });
    return;
  }

  const row = withReadonlyDatabase<{
    listing_path: string | null;
    design_path: string | null;
    design_id: number | null;
  } | null>(
    "design-image",
    null,
    (db) => db.prepare(`
      SELECT
        listings.image_url AS listing_path,
        designs.image_path AS design_path,
        designs.id AS design_id
      FROM listings
      LEFT JOIN designs ON designs.id = listings.design_id
      WHERE listings.id = ?
      LIMIT 1
    `).get(listingId) as {
      listing_path: string | null;
      design_path: string | null;
      design_id: number | null;
    } | null,
  );

  const candidatePaths = [
    row?.listing_path,
    row?.design_path,
    row?.design_id ? `./data/designs/design-${row.design_id}/design.png` : null,
    row?.design_id ? `./data/stickers/${row.design_id}/design.png` : null,
  ].filter(Boolean) as string[];

  for (const candidate of candidatePaths) {
    const imagePath = resolveDesignImagePath(candidate);
    if (!imagePath) {
      continue;
    }

    response.setHeader("Content-Type", "image/png");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.sendFile(imagePath);
    return;
  }

  console.log("Image not found for listing", listingId, "tried:", candidatePaths);
  response.status(404).json({
    error: "Image not found",
    tried: candidatePaths,
  });
});

app.post("/api/approve/:id", async (request, response) => {
  const listingId = Number.parseInt(request.params.id, 10);
  if (!Number.isFinite(listingId)) {
    response.status(400).json({ error: "Invalid listing ID." });
    return;
  }

  try {
    await refreshEtsyToken();
    const result = await approveListingById(listingId);
    auditLog("approve", "human", { etsyListingId: result.etsyListingId }, listingId);
    response.json(result);
  } catch (error) {
    response.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/reject/:id", (request, response) => {
  const listingId = Number.parseInt(request.params.id, 10);
  if (!Number.isFinite(listingId)) {
    response.status(400).json({ error: "Invalid listing ID." });
    return;
  }

  updateListingStatus(listingId, "rejected");
  auditLog("reject", "human", {}, listingId);
  response.json({ success: true });
});

app.post("/api/approve-all", async (_request, response) => {
  const pending = loadPendingApprovals();
  const errors: string[] = [];
  let approved = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await approveListingById(row.id);
      auditLog("approve", "human", { source: "approve-all" }, row.id);
      approved += 1;
    } catch (error) {
      failed += 1;
      errors.push(`Listing ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  response.json({ approved, failed, errors });
});

app.listen(port, host, () => {
  withReadonlyDatabase("schema-log", null, (db) => {
    const listingColumns = (db.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map((column) => column.name);
    const designColumns = (db.prepare("PRAGMA table_info(designs)").all() as Array<{ name: string }>).map((column) => column.name);
    console.log("LISTINGS columns:", listingColumns);
    console.log("DESIGNS columns:", designColumns);
    return null;
  });
  logger.action("Dashboard server started", "success", {
    port,
    host,
    url: `http://localhost:${port}`,
    databasePath,
  });
  console.log(`Jarvis dashboard running at http://localhost:${port}`);
});
