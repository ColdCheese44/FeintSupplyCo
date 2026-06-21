import "dotenv/config";

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "./logger.js";
import { normalizeProductTypeList, type ProductType } from "./product-types.js";

export interface NicheRecord {
  id: number;
  name: string;
  category: string | null;
  priority: number;
  product_types: ProductType[];
  active: number;
  created_at: string;
}

export interface ResearchResultRecord {
  id: number;
  niche_id: number | null;
  keyword: string;
  estimated_demand: string | null;
  competition_level: string | null;
  raw_data: string;
  created_at: string;
}

export interface ListingRecord {
  id: number;
  niche_id: number;
  title: string;
  description: string;
  tags: string;
  price: number;
  image_url: string | null;
  etsy_listing_id: string | null;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "published" | "failed" | "paused";
  created_at: string;
  published_at: string | null;
  design_id: number | null;
  product_type: string | null;
  quality_score: number | null;
  printify_product_id: string | null;
  printful_product_id: string | null;
  ai_assisted_tag: string | null;
  metadata: string | null;
}

export interface AnalyticsRecord {
  id: number;
  listing_id: number;
  etsy_listing_id: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
  recorded_at: string;
}

export interface DesignRecord {
  id: number;
  theme: string;
  product_type: string;
  image_path: string | null;
  print_file_path: string | null;
  mockup_paths: string | null;
  llm_model_used: string | null;
  cost_usd: number;
  quality_score: number | null;
  created_at: string;
  metadata: string | null;
}

export interface PodProductRecord {
  id: number;
  listing_id: number;
  printify_product_id: string | null;
  printful_product_id: string | null;
  blueprint_id: number | null;
  base_cost: number;
  retail_price: number;
  profit_margin: number;
  status: string;
  provider: string;
  variant_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface OrderRecord {
  id: number;
  etsy_receipt_id: string;
  printify_order_id: string | null;
  printful_order_id: string | null;
  buyer_id: string | null;
  buyer_name: string | null;
  listing_title: string | null;
  total_amount: number;
  profit_amount: number;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  provider: string;
  error_detail: string | null;
  shipping_error_count: number;
  metadata: string | null;
  created_at: string;
  fulfilled_at: string | null;
}

export interface TrademarkCandidateRecord {
  id: number;
  mark_text: string;
  registration_number: string | null;
  status_code: string;
  abandonment_date: string | null;
  last_owner: string | null;
  nice_class: string;
  recognition_score: number;
  legal_cleanliness_score: number;
  dossier_path: string | null;
  reviewed_by_human: number;
  metadata: string | null;
  created_at: string;
}

export interface MarketingEventRecord {
  id: number;
  listing_id: number | null;
  channel: string;
  action: string;
  cost_usd: number;
  clicks: number;
  conversions: number;
  scheduled_for: string | null;
  status: string;
  external_id: string | null;
  payload: string | null;
  created_at: string;
}

export interface LlmCallRecord {
  id: number;
  task_type: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  success: number;
  metadata: string | null;
  created_at: string;
}

export interface BudgetLedgerRecord {
  id: number;
  category: string;
  amount_usd: number;
  operation: string;
  reference_id: string | null;
  metadata: string | null;
  timestamp: string;
}

export interface HeartbeatLogRecord {
  id: number;
  started_at: string | null;
  finished_at: string | null;
  opportunities_considered: number;
  designs_generated: number;
  listings_published: number;
  total_cost_usd: number;
  error_count: number;
  errors: string | null;
  claude_calls: number;
  created_at: string;
}

export interface ShopSectionRecord {
  id: number;
  etsy_section_id: string;
  title: string;
  created_at: string;
}

export interface AutomationControlRecord {
  key: string;
  value: string;
  reason: string | null;
  updated_at: string;
}

export interface FailedOperationRecord {
  id: number;
  operation_type: string;
  listing_id: number | null;
  design_id: number | null;
  payload: string | null;
  error: string;
  attempts: number;
  last_attempted_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ProviderHealthStatusRecord {
  id: number;
  provider: string;
  status: string;
  latency_ms: number | null;
  created_at: string;
}

export interface IgmSnapshotRecord {
  id: number;
  status: string;
  running_apps: number;
  total_apps: number;
  earnings_usd: number | null;
  currency: string;
  detail: string | null;
  created_at: string;
}

export interface IgmSnapshotInput {
  status: string;
  runningApps: number;
  totalApps: number;
  earningsUsd?: number | null;
  currency?: string;
  detail?: unknown;
}

export interface NicheSeed {
  name: string;
  category?: string;
  priority?: number;
  product_types?: string[];
  active?: boolean;
}

export interface ResearchInsertInput {
  nicheId: number | null;
  keyword: string;
  estimatedDemand: string;
  competitionLevel: string;
  rawData: unknown;
}

export interface ListingInsertInput {
  nicheId: number;
  title: string;
  description: string;
  tags: string[];
  price: number;
  status?: ListingRecord["status"];
  designId?: number | null;
  productType?: string | null;
  qualityScore?: number | null;
  metadata?: unknown;
}

export interface AnalyticsInsertInput {
  listingId: number;
  etsyListingId: string;
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
}

export interface DesignInsertInput {
  theme: string;
  productType: string;
  imagePath?: string | null;
  printFilePath?: string | null;
  mockupPaths?: string[] | null;
  llmModelUsed?: string | null;
  costUsd?: number;
  qualityScore?: number | null;
  metadata?: unknown;
}

export interface PodProductInsertInput {
  listingId: number;
  printifyProductId?: string | null;
  printfulProductId?: string | null;
  blueprintId?: number | null;
  baseCost: number;
  retailPrice: number;
  profitMargin: number;
  status: string;
  provider: string;
  variantId?: string | null;
  metadata?: unknown;
}

export interface OrderUpsertInput {
  etsyReceiptId: string;
  printifyOrderId?: string | null;
  printfulOrderId?: string | null;
  buyerId?: string | null;
  buyerName?: string | null;
  listingTitle?: string | null;
  totalAmount: number;
  profitAmount: number;
  status: string;
  trackingNumber?: string | null;
  carrier?: string | null;
  provider: string;
  errorDetail?: string | null;
  shippingErrorCount?: number;
  metadata?: unknown;
  fulfilledAt?: string | null;
}

export interface TrademarkCandidateInsertInput {
  markText: string;
  registrationNumber?: string | null;
  statusCode: string;
  abandonmentDate?: string | null;
  lastOwner?: string | null;
  niceClass: string;
  recognitionScore: number;
  legalCleanlinessScore: number;
  dossierPath?: string | null;
  reviewedByHuman?: boolean;
  metadata?: unknown;
}

export interface MarketingEventInsertInput {
  listingId?: number | null;
  channel: string;
  action: string;
  costUsd?: number;
  clicks?: number;
  conversions?: number;
  scheduledFor?: string | null;
  status?: string;
  externalId?: string | null;
  payload?: unknown;
}

export interface LlmCallInsertInput {
  taskType: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  metadata?: unknown;
}

export interface BudgetLedgerInsertInput {
  category: string;
  amountUsd: number;
  operation: string;
  referenceId?: string | number | null;
  metadata?: unknown;
}

export interface HeartbeatLogInsertInput {
  startedAt?: string | null;
  finishedAt?: string | null;
  opportunitiesConsidered?: number;
  designsGenerated?: number;
  listingsPublished?: number;
  totalCostUsd?: number;
  errorCount?: number;
  errors?: string[] | string | null;
  claudeCalls?: number;
}

const logger = createLogger("db");
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDbPath = "./data/jarvis.db";
const defaultNichesPath = "./data/niches.json";

let database: Database.Database | null = null;

/**
 * Resolves a project-relative path into an absolute path anchored at the repo root.
 */
export function resolveProjectPath(candidatePath: string): string {
  return resolve(projectRoot, candidatePath);
}

/**
 * Returns the configured SQLite database path with a sensible project-local default.
 */
function getDatabasePath(): string {
  const configuredPath = process.env.DB_PATH?.trim() || defaultDbPath;
  return resolveProjectPath(configuredPath);
}

/**
 * Ensures the parent directory for the SQLite database exists before opening it.
 */
function ensureDatabaseDirectory(): void {
  const databasePath = getDatabasePath();
  const directoryPath = dirname(databasePath);
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

/**
 * Serializes optional metadata payloads into JSON so complex records remain queryable.
 */
function serializeMetadata(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

/**
 * Parses the stored niche product-type JSON into the canonical array consumed by heartbeat rotation and listing generation.
 */
function parseNicheProductTypes(value: string | null | undefined): ProductType[] {
  if (!value) {
    return normalizeProductTypeList(null);
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeProductTypeList(parsed.filter((entry): entry is string => typeof entry === "string"))
      : normalizeProductTypeList(null);
  } catch {
    return normalizeProductTypeList(null);
  }
}

/**
 * Normalizes a raw niche row from SQLite into the richer runtime shape used elsewhere in Jarvis.
 */
function mapNicheRow(row: {
  id: number;
  name: string;
  category: string | null;
  priority: number;
  product_types: string | null;
  active: number;
  created_at: string;
}): NicheRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    priority: row.priority,
    product_types: parseNicheProductTypes(row.product_types),
    active: row.active,
    created_at: row.created_at,
  };
}

/**
 * Checks whether a table already exposes a given column before an additive migration runs.
 */
function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

/**
 * Adds a new column only when it is missing so repeated startups stay safe and idempotent.
 */
function ensureColumnExists(db: Database.Database, tableName: string, columnDefinition: string): void {
  const columnName = columnDefinition.split(/\s+/)[0];
  if (!tableHasColumn(db, tableName, columnName)) {
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
}

/**
 * Rebuilds the provider_health table when it still uses the legacy `checked_at` column.
 *
 * Older databases created provider_health with `checked_at`, but the current code
 * expects `created_at` (with a CURRENT_TIMESTAMP default that ALTER TABLE ADD COLUMN
 * cannot apply). A guarded table rebuild renames the column while preserving rows.
 */
function migrateProviderHealthSchema(db: Database.Database): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_health'")
    .get();
  if (!tableExists) {
    return;
  }
  if (tableHasColumn(db, "provider_health", "created_at")) {
    return;
  }
  if (!tableHasColumn(db, "provider_health", "checked_at")) {
    return;
  }

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE provider_health_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO provider_health_migrated (id, provider, status, latency_ms, created_at)
        SELECT id, provider, status, latency_ms, checked_at FROM provider_health;
      DROP TABLE provider_health;
      ALTER TABLE provider_health_migrated RENAME TO provider_health;
    `);
  });
  rebuild();
  logger.action("Migrated provider_health.checked_at to created_at", "success");
}

/**
 * Creates every required table and performs additive migrations for the evolving automation stack.
 */
function runMigrations(db: Database.Database): void {
  migrateProviderHealthSchema(db);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS niches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      priority INTEGER DEFAULT 1,
      product_types TEXT,
      active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS research_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      niche_id INTEGER REFERENCES niches(id),
      keyword TEXT,
      estimated_demand TEXT,
      competition_level TEXT,
      raw_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      niche_id INTEGER REFERENCES niches(id),
      title TEXT,
      description TEXT,
      tags TEXT,
      price REAL,
      image_url TEXT,
      etsy_listing_id TEXT,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER REFERENCES listings(id),
      etsy_listing_id TEXT,
      views INTEGER DEFAULT 0,
      favorites INTEGER DEFAULT 0,
      sales INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      theme TEXT NOT NULL,
      product_type TEXT NOT NULL,
      image_path TEXT,
      print_file_path TEXT,
      mockup_paths TEXT,
      llm_model_used TEXT,
      cost_usd REAL DEFAULT 0,
      quality_score REAL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pod_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER REFERENCES listings(id),
      printify_product_id TEXT,
      printful_product_id TEXT,
      blueprint_id INTEGER,
      base_cost REAL DEFAULT 0,
      retail_price REAL DEFAULT 0,
      profit_margin REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      provider TEXT DEFAULT 'printify',
      variant_id TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      etsy_receipt_id TEXT UNIQUE,
      printify_order_id TEXT,
      printful_order_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      listing_title TEXT,
      total_amount REAL DEFAULT 0,
      profit_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'new',
      tracking_number TEXT,
      carrier TEXT,
      provider TEXT DEFAULT 'printify',
      error_detail TEXT,
      shipping_error_count INTEGER DEFAULT 0,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      fulfilled_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS trademark_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark_text TEXT NOT NULL,
      registration_number TEXT,
      status_code TEXT NOT NULL,
      abandonment_date DATETIME,
      last_owner TEXT,
      nice_class TEXT,
      recognition_score REAL DEFAULT 0,
      legal_cleanliness_score REAL DEFAULT 0,
      dossier_path TEXT,
      reviewed_by_human BOOLEAN DEFAULT 0,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS marketing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER REFERENCES listings(id),
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      cost_usd REAL DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      scheduled_for DATETIME,
      status TEXT DEFAULT 'scheduled',
      external_id TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      success BOOLEAN DEFAULT 1,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS automation_controls (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      reason TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS failed_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_type TEXT NOT NULL,
      listing_id INTEGER REFERENCES listings(id),
      design_id INTEGER REFERENCES designs(id),
      payload TEXT,
      error TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_attempted_at DATETIME,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS provider_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS budget_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      operation TEXT NOT NULL,
      reference_id TEXT,
      metadata TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shop_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      etsy_section_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at DATETIME,
      finished_at DATETIME,
      opportunities_considered INTEGER DEFAULT 0,
      designs_generated INTEGER DEFAULT 0,
      listings_published INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      errors TEXT,
      claude_calls INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS igm_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      running_apps INTEGER DEFAULT 0,
      total_apps INTEGER DEFAULT 0,
      earnings_usd REAL,
      currency TEXT DEFAULT 'USD',
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('human', 'jarvis', 'system')),
      listing_id INTEGER REFERENCES listings(id),
      design_id INTEGER REFERENCES designs(id),
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_research_results_niche_created ON research_results(niche_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_listing_recorded ON analytics(listing_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_marketing_channel_created ON marketing_events(channel, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_task_created ON llm_calls(task_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_failed_operations_retry ON failed_operations(resolved_at, attempts, created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_health_latest ON provider_health(provider, id DESC);
    CREATE INDEX IF NOT EXISTS idx_budget_ledger_category_time ON budget_ledger(category, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_sections_title ON shop_sections(title);
    CREATE INDEX IF NOT EXISTS idx_heartbeat_log_created ON heartbeat_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_igm_snapshots_created ON igm_snapshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_listing ON audit_log(listing_id, created_at DESC);
  `);

  ensureColumnExists(db, "listings", "design_id INTEGER REFERENCES designs(id)");
  ensureColumnExists(db, "niches", "product_types TEXT");
  ensureColumnExists(db, "listings", "product_type TEXT");
  ensureColumnExists(db, "listings", "quality_score REAL");
  ensureColumnExists(db, "listings", "printify_product_id TEXT");
  ensureColumnExists(db, "listings", "printful_product_id TEXT");
  ensureColumnExists(db, "listings", "ai_assisted_tag TEXT DEFAULT 'AI-assisted design'");
  ensureColumnExists(db, "listings", "metadata TEXT");
  ensureColumnExists(db, "orders", "buyer_name TEXT");
  ensureColumnExists(db, "orders", "listing_title TEXT");
  ensureColumnExists(db, "orders", "carrier TEXT");

  db.prepare(`
    UPDATE listings
    SET status = 'pending_approval'
    WHERE status = 'approved'
      AND etsy_listing_id IS NULL
  `).run();

  db.prepare(`
    UPDATE listings
    SET status = 'pending_approval'
    WHERE status = 'draft'
      AND product_type = 't-shirt'
      AND etsy_listing_id IS NULL
  `).run();
}

/**
 * Opens the SQLite database lazily and keeps a singleton connection for the process.
 */
export function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  ensureDatabaseDirectory();
  database = new Database(getDatabasePath());
  runMigrations(database);
  logger.action("Database opened and migrations applied", "success", { path: getDatabasePath() });
  return database;
}

/**
 * Reads the configured niche seed file so startup can populate first-run data.
 */
function readNicheSeeds(seedFilePath: string): NicheSeed[] {
  const absolutePath = resolveProjectPath(seedFilePath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const fileContents = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(fileContents) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of niches in ${absolutePath}.`);
  }
  return parsed as NicheSeed[];
}

/**
 * Seeds the niches table from the configured JSON file without duplicating names.
 */
export function seedNichesFromFile(seedFilePath = process.env.TARGET_NICHES_FILE?.trim() || defaultNichesPath): number {
  const db = getDatabase();
  const seeds = readNicheSeeds(seedFilePath);
  const selectStatement = db.prepare("SELECT id FROM niches WHERE name = ?");
  const insertStatement = db.prepare(`
    INSERT INTO niches (name, category, priority, product_types, active)
    VALUES (@name, @category, @priority, @product_types, @active)
  `);
  const updateStatement = db.prepare(`
    UPDATE niches
    SET category = @category, priority = @priority, product_types = @product_types, active = @active
    WHERE id = @id
  `);

  let changedRows = 0;
  const seedTransaction = db.transaction((nicheSeeds: NicheSeed[]) => {
    for (const nicheSeed of nicheSeeds) {
      const existing = selectStatement.get(nicheSeed.name) as { id: number } | undefined;
      const payload = {
        name: nicheSeed.name,
        category: nicheSeed.category ?? null,
        priority: nicheSeed.priority ?? 1,
        product_types: JSON.stringify(normalizeProductTypeList(nicheSeed.product_types)),
        active: nicheSeed.active === false ? 0 : 1,
      };

      if (existing) {
        updateStatement.run({ ...payload, id: existing.id });
      } else {
        insertStatement.run(payload);
      }
      changedRows += 1;
    }
  });

  seedTransaction(seeds);
  logger.action("Seeded niches from configuration", "success", { seedFilePath, changedRows });
  return changedRows;
}

/**
 * Initializes the database connection and seeds default niches for first-run use.
 */
export function initializeDatabase(): Database.Database {
  const db = getDatabase();
  seedNichesFromFile();
  return db;
}

/**
 * Returns all active niches ordered by priority so research can process the most important ones first.
 */
export function getActiveNiches(): NicheRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, name, category, priority, product_types, active, created_at
    FROM niches
    WHERE active = ?
    ORDER BY priority ASC, created_at ASC
  `);
  return (statement.all(1) as Array<{
    id: number;
    name: string;
    category: string | null;
    priority: number;
    product_types: string | null;
    active: number;
    created_at: string;
  }>).map(mapNicheRow);
}

/**
 * Fetches a single niche record by ID so downstream skills can enrich their outputs.
 */
export function getNicheById(nicheId: number): NicheRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, name, category, priority, product_types, active, created_at
    FROM niches
    WHERE id = ?
  `);
  const row = statement.get(nicheId) as {
    id: number;
    name: string;
    category: string | null;
    priority: number;
    product_types: string | null;
    active: number;
    created_at: string;
  } | undefined;
  return row ? mapNicheRow(row) : null;
}

/**
 * Stores a research result snapshot for a niche so future runs can compare opportunities over time.
 */
export function insertResearchResult(input: ResearchInsertInput): ResearchResultRecord {
  const db = getDatabase();
  const insertStatement = db.prepare(`
    INSERT INTO research_results (niche_id, keyword, estimated_demand, competition_level, raw_data)
    VALUES (@niche_id, @keyword, @estimated_demand, @competition_level, @raw_data)
  `);
  const result = insertStatement.run({
    niche_id: input.nicheId,
    keyword: input.keyword,
    estimated_demand: input.estimatedDemand,
    competition_level: input.competitionLevel,
    raw_data: JSON.stringify(input.rawData),
  });

  const selectStatement = db.prepare(`
    SELECT id, niche_id, keyword, estimated_demand, competition_level, raw_data, created_at
    FROM research_results
    WHERE id = ?
  `);
  return selectStatement.get(result.lastInsertRowid) as ResearchResultRecord;
}

/**
 * Returns recent research results for a niche so pricing and copy can use nearby market context.
 */
export function getRecentResearchResultsForNiche(nicheId: number, limit = 10): ResearchResultRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, keyword, estimated_demand, competition_level, raw_data, created_at
    FROM research_results
    WHERE niche_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return statement.all(nicheId, limit) as ResearchResultRecord[];
}

/**
 * Creates a local draft listing record before any image generation or Etsy publishing occurs.
 */
export function createDraftListing(input: ListingInsertInput): ListingRecord {
  const db = getDatabase();
  const status = input.status ?? "draft";
  const insertStatement = db.prepare(`
    INSERT INTO listings (niche_id, title, description, tags, price, status, design_id, product_type, quality_score, metadata)
    VALUES (@niche_id, @title, @description, @tags, @price, @status, @design_id, @product_type, @quality_score, @metadata)
  `);
  const result = insertStatement.run({
    niche_id: input.nicheId,
    title: input.title,
    description: input.description,
    tags: input.tags.join(","),
    price: input.price,
    status,
    design_id: input.designId ?? null,
    product_type: input.productType ?? null,
    quality_score: input.qualityScore ?? null,
    metadata: serializeMetadata(input.metadata),
  });

  return getListingById(Number(result.lastInsertRowid)) as ListingRecord;
}

/**
 * Fetches a listing record by ID so downstream skills can continue the workflow from stored state.
 */
export function getListingById(listingId: number): ListingRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE id = ?
  `);
  return (statement.get(listingId) as ListingRecord | undefined) ?? null;
}

/**
 * Resolves a local listing record by Etsy listing ID for downstream fulfillment workflows.
 */
export function getListingByEtsyListingId(etsyListingId: string): ListingRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE etsy_listing_id = ?
  `);
  return (statement.get(etsyListingId) as ListingRecord | undefined) ?? null;
}

/**
 * Returns recent draft listings so the orchestrator can publish only newly generated work.
 */
export function getRecentDraftListings(limit = 10): ListingRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE status = 'draft'
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return statement.all(limit) as ListingRecord[];
}

/**
 * Returns listings awaiting human approval with joined niche and design context for the dashboard review queue.
 */
export function getPendingApprovalListings(limit = 100): Array<ListingRecord & { niche_name: string | null; theme: string | null; local_design_path: string | null }> {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT
      listings.id,
      listings.niche_id,
      listings.title,
      listings.description,
      listings.tags,
      listings.price,
      listings.image_url,
      listings.etsy_listing_id,
      listings.status,
      listings.created_at,
      listings.published_at,
      listings.design_id,
      listings.product_type,
      listings.quality_score,
      listings.printify_product_id,
      listings.printful_product_id,
      listings.ai_assisted_tag,
      listings.metadata,
      niches.name AS niche_name,
      designs.theme AS theme,
      COALESCE(designs.image_path, listings.image_url) AS local_design_path
    FROM listings
    LEFT JOIN niches ON niches.id = listings.niche_id
    LEFT JOIN designs ON designs.id = listings.design_id
    WHERE listings.status = 'pending_approval'
    ORDER BY datetime(listings.created_at) DESC, listings.id DESC
    LIMIT ?
  `);
  return statement.all(limit) as Array<ListingRecord & { niche_name: string | null; theme: string | null; local_design_path: string | null }>;
}

/**
 * Returns recently published listings so marketing automation can target fresh catalog items.
 */
export function getRecentlyPublishedListings(hours = 72): ListingRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE status = 'published'
      AND published_at IS NOT NULL
      AND published_at >= datetime('now', ?)
    ORDER BY published_at DESC
  `);
  return statement.all(`-${hours} hours`) as ListingRecord[];
}

/**
 * Updates the local image path for a listing after image generation completes.
 */
export function updateListingImagePath(listingId: number, imagePath: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET image_url = ?
    WHERE id = ?
  `).run(imagePath, listingId);
}

/**
 * Links a listing to a generated design record and stores the associated product metadata.
 */
export function updateListingDesignReference(
  listingId: number,
  designId: number,
  productType: string,
  qualityScore?: number | null,
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET design_id = ?, product_type = ?, quality_score = COALESCE(?, quality_score)
    WHERE id = ?
  `).run(designId, productType, qualityScore ?? null, listingId);
}

/**
 * Marks a listing as published and persists the Etsy listing identifier for analytics and fulfillment lookups.
 */
export function markListingPublished(listingId: number, etsyListingId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET status = 'published', etsy_listing_id = ?, published_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(etsyListingId, listingId);
}

/**
 * Updates the listing with the Printify product ID once POD publishing completes.
 */
export function updateListingPrintifyProductId(listingId: number, printifyProductId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET printify_product_id = ?, ai_assisted_tag = COALESCE(ai_assisted_tag, 'AI-assisted design')
    WHERE id = ?
  `).run(printifyProductId, listingId);
}

/**
 * Updates the listing with the Printful product ID once POD syncing completes.
 */
export function updateListingPrintfulProductId(listingId: number, printfulProductId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET printful_product_id = ?, ai_assisted_tag = COALESCE(ai_assisted_tag, 'AI-assisted design')
    WHERE id = ?
  `).run(printfulProductId, listingId);
}

/**
 * Marks a listing as failed so future runs can skip or inspect unsuccessful publish attempts.
 */
export function markListingFailed(listingId: number, metadata?: unknown): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET status = 'failed', metadata = COALESCE(?, metadata)
    WHERE id = ?
  `).run(serializeMetadata(metadata), listingId);
}

/**
 * Pauses a listing explicitly when a global safety rail or business rule requires it.
 */
export function markListingPaused(listingId: number, metadata?: unknown): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET status = 'paused', metadata = COALESCE(?, metadata)
    WHERE id = ?
  `).run(serializeMetadata(metadata), listingId);
}

/**
 * Sets a listing status to an explicit workflow state used by approval and review tooling.
 */
export function updateListingStatus(listingId: number, status: ListingRecord["status"], metadata?: unknown): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE listings
    SET status = ?, metadata = COALESCE(?, metadata)
    WHERE id = ?
  `).run(status, serializeMetadata(metadata), listingId);
}

/**
 * Marks a listing whose Etsy resource returned 404 as failed so heartbeats stop retrying dead listings.
 *
 * Self-healing: a published listing that no longer exists on Etsy is excluded from future analytics and
 * tag-refresh passes. Reversible — an operator can re-publish it. Status only; metadata is left intact.
 */
export function markListingEtsyMissing(listingId: number): void {
  const db = getDatabase();
  db.prepare("UPDATE listings SET status = 'failed' WHERE id = ? AND status = 'published'").run(listingId);
}

/**
 * Returns all published listings so analytics can refresh the latest store performance.
 */
export function getPublishedListings(): ListingRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE status = 'published'
    ORDER BY published_at DESC, created_at DESC
  `);
  return statement.all() as ListingRecord[];
}

/**
 * Returns listings marked for manual review so operator-facing reports can separate them from auto-publish candidates.
 */
export function getListingsFlaggedForManualReview(limit = 10): ListingRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, niche_id, title, description, tags, price, image_url, etsy_listing_id, status, created_at, published_at,
           design_id, product_type, quality_score, printify_product_id, printful_product_id, ai_assisted_tag, metadata
    FROM listings
    WHERE metadata LIKE '%"requiresManualReview":true%'
       OR metadata LIKE '%"requires_manual_review":true%'
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return statement.all(limit) as ListingRecord[];
}

/**
 * Inserts a snapshot of listing performance so trend reporting can show changes over time.
 */
export function insertAnalyticsSnapshot(input: AnalyticsInsertInput): AnalyticsRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO analytics (listing_id, etsy_listing_id, views, favorites, sales, revenue)
    VALUES (@listing_id, @etsy_listing_id, @views, @favorites, @sales, @revenue)
  `).run({
    listing_id: input.listingId,
    etsy_listing_id: input.etsyListingId,
    views: input.views,
    favorites: input.favorites,
    sales: input.sales,
    revenue: input.revenue,
  });

  return db.prepare(`
    SELECT id, listing_id, etsy_listing_id, views, favorites, sales, revenue, recorded_at
    FROM analytics
    WHERE id = ?
  `).get(result.lastInsertRowid) as AnalyticsRecord;
}

/**
 * Creates a new design record before or after assets are generated so cost and quality can be tracked separately.
 */
export function createDesignRecord(input: DesignInsertInput): DesignRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO designs (theme, product_type, image_path, print_file_path, mockup_paths, llm_model_used, cost_usd, quality_score, metadata)
    VALUES (@theme, @product_type, @image_path, @print_file_path, @mockup_paths, @llm_model_used, @cost_usd, @quality_score, @metadata)
  `).run({
    theme: input.theme,
    product_type: input.productType,
    image_path: input.imagePath ?? null,
    print_file_path: input.printFilePath ?? null,
    mockup_paths: input.mockupPaths ? JSON.stringify(input.mockupPaths) : null,
    llm_model_used: input.llmModelUsed ?? null,
    cost_usd: input.costUsd ?? 0,
    quality_score: input.qualityScore ?? null,
    metadata: serializeMetadata(input.metadata),
  });

  return getDesignById(Number(result.lastInsertRowid)) as DesignRecord;
}

/**
 * Fetches a design record by ID so downstream publish and marketing flows can reuse generated assets.
 */
export function getDesignById(designId: number): DesignRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, theme, product_type, image_path, print_file_path, mockup_paths, llm_model_used, cost_usd, quality_score, metadata, created_at
    FROM designs
    WHERE id = ?
  `);
  return (statement.get(designId) as DesignRecord | undefined) ?? null;
}

/**
 * Updates generated design asset paths and quality metadata after a design job completes.
 */
export function updateDesignAssets(
  designId: number,
  updates: {
    imagePath?: string | null;
    printFilePath?: string | null;
    mockupPaths?: string[] | null;
    llmModelUsed?: string | null;
    costUsd?: number;
    qualityScore?: number | null;
    metadata?: unknown;
  },
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE designs
    SET image_path = COALESCE(@image_path, image_path),
        print_file_path = COALESCE(@print_file_path, print_file_path),
        mockup_paths = COALESCE(@mockup_paths, mockup_paths),
        llm_model_used = COALESCE(@llm_model_used, llm_model_used),
        cost_usd = COALESCE(@cost_usd, cost_usd),
        quality_score = COALESCE(@quality_score, quality_score),
        metadata = COALESCE(@metadata, metadata)
    WHERE id = @id
  `).run({
    id: designId,
    image_path: updates.imagePath ?? null,
    print_file_path: updates.printFilePath ?? null,
    mockup_paths: updates.mockupPaths ? JSON.stringify(updates.mockupPaths) : null,
    llm_model_used: updates.llmModelUsed ?? null,
    cost_usd: updates.costUsd ?? null,
    quality_score: updates.qualityScore ?? null,
    metadata: serializeMetadata(updates.metadata),
  });
}

/**
 * Inserts or refreshes a POD product mapping so listing-to-provider relationships remain current.
 */
export function upsertPodProduct(input: PodProductInsertInput): PodProductRecord {
  const db = getDatabase();
  const existing = db.prepare(`SELECT id FROM pod_products WHERE listing_id = ?`).get(input.listingId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE pod_products
      SET printify_product_id = @printify_product_id,
          printful_product_id = @printful_product_id,
          blueprint_id = @blueprint_id,
          base_cost = @base_cost,
          retail_price = @retail_price,
          profit_margin = @profit_margin,
          status = @status,
          provider = @provider,
          variant_id = @variant_id,
      metadata = @metadata
      WHERE listing_id = @listing_id
    `).run({
      listing_id: input.listingId,
      printify_product_id: input.printifyProductId ?? null,
      printful_product_id: input.printfulProductId ?? null,
      blueprint_id: input.blueprintId ?? null,
      base_cost: input.baseCost,
      retail_price: input.retailPrice,
      profit_margin: input.profitMargin,
      status: input.status,
      provider: input.provider,
      variant_id: input.variantId ?? null,
      metadata: serializeMetadata(input.metadata),
    });
  } else {
    db.prepare(`
      INSERT INTO pod_products (
        listing_id, printify_product_id, printful_product_id, blueprint_id, base_cost, retail_price,
        profit_margin, status, provider, variant_id, metadata
      )
      VALUES (
        @listing_id, @printify_product_id, @printful_product_id, @blueprint_id, @base_cost, @retail_price,
        @profit_margin, @status, @provider, @variant_id, @metadata
      )
    `).run({
      listing_id: input.listingId,
      printify_product_id: input.printifyProductId ?? null,
      printful_product_id: input.printfulProductId ?? null,
      blueprint_id: input.blueprintId ?? null,
      base_cost: input.baseCost,
      retail_price: input.retailPrice,
      profit_margin: input.profitMargin,
      status: input.status,
      provider: input.provider,
      variant_id: input.variantId ?? null,
      metadata: serializeMetadata(input.metadata),
    });
  }

  db.prepare(`
    UPDATE listings
    SET printify_product_id = COALESCE(@printify_product_id, printify_product_id),
        printful_product_id = COALESCE(@printful_product_id, printful_product_id)
    WHERE id = @listing_id
  `).run({
    listing_id: input.listingId,
    printify_product_id: input.printifyProductId ?? null,
    printful_product_id: input.printfulProductId ?? null,
  });

  return getPodProductByListingId(input.listingId) as PodProductRecord;
}

/**
 * Fetches the POD product mapping for a listing so order orchestration can route fulfillment correctly.
 */
export function getPodProductByListingId(listingId: number): PodProductRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, listing_id, printify_product_id, printful_product_id, blueprint_id, base_cost, retail_price, profit_margin,
           status, provider, variant_id, metadata, created_at
    FROM pod_products
    WHERE listing_id = ?
  `);
  return (statement.get(listingId) as PodProductRecord | undefined) ?? null;
}

/**
 * Updates a POD product status after publish, sync, or pause actions complete.
 */
export function updatePodProductStatus(listingId: number, status: string, metadata?: unknown): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE pod_products
    SET status = ?, metadata = COALESCE(?, metadata)
    WHERE listing_id = ?
  `).run(status, serializeMetadata(metadata), listingId);
}

/**
 * Creates or updates an order record keyed by Etsy receipt ID so repeated polling stays idempotent.
 */
export function upsertOrder(input: OrderUpsertInput): OrderRecord {
  const db = getDatabase();
  const existing = db.prepare(`SELECT id FROM orders WHERE etsy_receipt_id = ?`).get(input.etsyReceiptId) as { id: number } | undefined;

  const payload = {
    etsy_receipt_id: input.etsyReceiptId,
    printify_order_id: input.printifyOrderId ?? null,
    printful_order_id: input.printfulOrderId ?? null,
    buyer_id: input.buyerId ?? null,
    buyer_name: input.buyerName ?? null,
    listing_title: input.listingTitle ?? null,
    total_amount: input.totalAmount,
    profit_amount: input.profitAmount,
    status: input.status,
    tracking_number: input.trackingNumber ?? null,
    carrier: input.carrier ?? null,
    provider: input.provider,
    error_detail: input.errorDetail ?? null,
    shipping_error_count: input.shippingErrorCount ?? 0,
    metadata: serializeMetadata(input.metadata),
    fulfilled_at: input.fulfilledAt ?? null,
  };

  if (existing) {
    db.prepare(`
      UPDATE orders
      SET printify_order_id = @printify_order_id,
          printful_order_id = @printful_order_id,
          buyer_id = @buyer_id,
          buyer_name = @buyer_name,
          listing_title = COALESCE(@listing_title, listing_title),
          total_amount = @total_amount,
          profit_amount = @profit_amount,
          status = @status,
          tracking_number = @tracking_number,
          carrier = COALESCE(@carrier, carrier),
          provider = @provider,
          error_detail = @error_detail,
          shipping_error_count = @shipping_error_count,
          metadata = @metadata,
          fulfilled_at = @fulfilled_at
      WHERE etsy_receipt_id = @etsy_receipt_id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO orders (
        etsy_receipt_id, printify_order_id, printful_order_id, buyer_id, buyer_name, listing_title, total_amount, profit_amount,
        status, tracking_number, carrier, provider, error_detail, shipping_error_count, metadata, fulfilled_at
      )
      VALUES (
        @etsy_receipt_id, @printify_order_id, @printful_order_id, @buyer_id, @buyer_name, @listing_title, @total_amount, @profit_amount,
        @status, @tracking_number, @carrier, @provider, @error_detail, @shipping_error_count, @metadata, @fulfilled_at
      )
    `).run(payload);
  }

  return getOrderByReceiptId(input.etsyReceiptId) as OrderRecord;
}

/**
 * Fetches an order record by Etsy receipt ID so polling workflows can resume from stored state.
 */
export function getOrderByReceiptId(etsyReceiptId: string): OrderRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, etsy_receipt_id, printify_order_id, printful_order_id, buyer_id, buyer_name, listing_title, total_amount, profit_amount, status,
           tracking_number, carrier, provider, error_detail, shipping_error_count, metadata, created_at, fulfilled_at
    FROM orders
    WHERE etsy_receipt_id = ?
  `);
  return (statement.get(etsyReceiptId) as OrderRecord | undefined) ?? null;
}

/**
 * Returns recent orders ordered by creation time so business health rules can inspect the latest outcomes.
 */
export function getRecentOrders(limit = 20): OrderRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, etsy_receipt_id, printify_order_id, printful_order_id, buyer_id, buyer_name, listing_title, total_amount, profit_amount, status,
           tracking_number, carrier, provider, error_detail, shipping_error_count, metadata, created_at, fulfilled_at
    FROM orders
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return statement.all(limit) as OrderRecord[];
}

/**
 * Calculates the number of most recent orders that fell below the minimum target profit margin.
 */
export function getConsecutiveLowMarginOrderCount(threshold = 0.15, sampleSize = 5): number {
  const orders = getRecentOrders(sampleSize);
  let count = 0;

  for (const order of orders) {
    if (order.total_amount <= 0) {
      break;
    }
    const margin = order.profit_amount / order.total_amount;
    if (margin < threshold) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Calculates the number of most recent provider failures caused by shipping errors.
 */
export function getConsecutiveShippingErrorCount(sampleSize = 3): number {
  const orders = getRecentOrders(sampleSize);
  let count = 0;

  for (const order of orders) {
    if (order.error_detail && order.error_detail.toLowerCase().includes("shipping")) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Stores a trademark candidate record so human review can happen asynchronously from discovery.
 */
export function createTrademarkCandidate(input: TrademarkCandidateInsertInput): TrademarkCandidateRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO trademark_candidates (
      mark_text, registration_number, status_code, abandonment_date, last_owner, nice_class,
      recognition_score, legal_cleanliness_score, dossier_path, reviewed_by_human, metadata
    )
    VALUES (
      @mark_text, @registration_number, @status_code, @abandonment_date, @last_owner, @nice_class,
      @recognition_score, @legal_cleanliness_score, @dossier_path, @reviewed_by_human, @metadata
    )
  `).run({
    mark_text: input.markText,
    registration_number: input.registrationNumber ?? null,
    status_code: input.statusCode,
    abandonment_date: input.abandonmentDate ?? null,
    last_owner: input.lastOwner ?? null,
    nice_class: input.niceClass,
    recognition_score: input.recognitionScore,
    legal_cleanliness_score: input.legalCleanlinessScore,
    dossier_path: input.dossierPath ?? null,
    reviewed_by_human: input.reviewedByHuman ? 1 : 0,
    metadata: serializeMetadata(input.metadata),
  });

  return getTrademarkCandidateById(Number(result.lastInsertRowid)) as TrademarkCandidateRecord;
}

/**
 * Fetches a single trademark candidate by ID for dossier refreshes or review workflows.
 */
export function getTrademarkCandidateById(candidateId: number): TrademarkCandidateRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, mark_text, registration_number, status_code, abandonment_date, last_owner, nice_class,
           recognition_score, legal_cleanliness_score, dossier_path, reviewed_by_human, metadata, created_at
    FROM trademark_candidates
    WHERE id = ?
  `);
  return (statement.get(candidateId) as TrademarkCandidateRecord | undefined) ?? null;
}

/**
 * Returns trademark candidates above a threshold so Discord alerts can focus on the strongest opportunities.
 */
export function listTrademarkCandidatesAboveThreshold(threshold: number): TrademarkCandidateRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, mark_text, registration_number, status_code, abandonment_date, last_owner, nice_class,
           recognition_score, legal_cleanliness_score, dossier_path, reviewed_by_human, metadata, created_at
    FROM trademark_candidates
    WHERE ((recognition_score + legal_cleanliness_score) / 2.0) >= ?
    ORDER BY created_at DESC
  `);
  return statement.all(threshold) as TrademarkCandidateRecord[];
}

/**
 * Stores a marketing event so Jarvis can schedule or measure cross-channel traffic actions.
 */
export function createMarketingEvent(input: MarketingEventInsertInput): MarketingEventRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO marketing_events (
      listing_id, channel, action, cost_usd, clicks, conversions, scheduled_for, status, external_id, payload
    )
    VALUES (
      @listing_id, @channel, @action, @cost_usd, @clicks, @conversions, @scheduled_for, @status, @external_id, @payload
    )
  `).run({
    listing_id: input.listingId ?? null,
    channel: input.channel,
    action: input.action,
    cost_usd: input.costUsd ?? 0,
    clicks: input.clicks ?? 0,
    conversions: input.conversions ?? 0,
    scheduled_for: input.scheduledFor ?? null,
    status: input.status ?? "scheduled",
    external_id: input.externalId ?? null,
    payload: serializeMetadata(input.payload),
  });

  return getMarketingEventById(Number(result.lastInsertRowid)) as MarketingEventRecord;
}

/**
 * Fetches a single marketing event by ID so later updates can reuse the stored row.
 */
export function getMarketingEventById(eventId: number): MarketingEventRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, listing_id, channel, action, cost_usd, clicks, conversions, scheduled_for, status, external_id, payload, created_at
    FROM marketing_events
    WHERE id = ?
  `);
  return (statement.get(eventId) as MarketingEventRecord | undefined) ?? null;
}

/**
 * Returns scheduled marketing events that are due so the heartbeat loop can publish them on time.
 */
export function getPendingMarketingEvents(limit = 50): MarketingEventRecord[] {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT id, listing_id, channel, action, cost_usd, clicks, conversions, scheduled_for, status, external_id, payload, created_at
    FROM marketing_events
    WHERE status = 'scheduled'
      AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_TIMESTAMP)
    ORDER BY COALESCE(scheduled_for, created_at) ASC
    LIMIT ?
  `);
  return statement.all(limit) as MarketingEventRecord[];
}

/**
 * Marks a marketing event as published and optionally stores the provider-side identifier returned by the channel.
 */
export function markMarketingEventPublished(eventId: number, externalId?: string | null): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE marketing_events
    SET status = 'published', external_id = COALESCE(?, external_id)
    WHERE id = ?
  `).run(externalId ?? null, eventId);
}

/**
 * Records the outcome metrics for an existing marketing event after traffic data arrives.
 */
export function updateMarketingEventMetrics(eventId: number, clicks: number, conversions: number, costUsd?: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE marketing_events
    SET clicks = ?, conversions = ?, cost_usd = COALESCE(?, cost_usd)
    WHERE id = ?
  `).run(clicks, conversions, costUsd ?? null, eventId);
}

/**
 * Stores a normalized LLM call record so routing costs and latency can be analyzed over time.
 */
export function recordLlmCall(input: LlmCallInsertInput): LlmCallRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO llm_calls (task_type, model, provider, prompt_tokens, completion_tokens, cost_usd, latency_ms, success, metadata)
    VALUES (@task_type, @model, @provider, @prompt_tokens, @completion_tokens, @cost_usd, @latency_ms, @success, @metadata)
  `).run({
    task_type: input.taskType,
    model: input.model,
    provider: input.provider,
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    cost_usd: input.costUsd,
    latency_ms: input.latencyMs,
    success: input.success ? 1 : 0,
    metadata: serializeMetadata(input.metadata),
  });

  return db.prepare(`
    SELECT id, task_type, model, provider, prompt_tokens, completion_tokens, cost_usd, latency_ms, success, metadata, created_at
    FROM llm_calls
    WHERE id = ?
  `).get(result.lastInsertRowid) as LlmCallRecord;
}

/**
 * Records one budget-affecting operation so Jarvis can enforce caps and audit reinvestment decisions over time.
 */
export function recordBudgetLedgerEntry(input: BudgetLedgerInsertInput): BudgetLedgerRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO budget_ledger (category, amount_usd, operation, reference_id, metadata)
    VALUES (@category, @amount_usd, @operation, @reference_id, @metadata)
  `).run({
    category: input.category,
    amount_usd: input.amountUsd,
    operation: input.operation,
    reference_id: input.referenceId == null ? null : String(input.referenceId),
    metadata: serializeMetadata(input.metadata),
  });

  return db.prepare(`
    SELECT id, category, amount_usd, operation, reference_id, metadata, timestamp
    FROM budget_ledger
    WHERE id = ?
  `).get(result.lastInsertRowid) as BudgetLedgerRecord;
}

/**
 * Returns budget-ledger totals for one category within an optional SQLite datetime window.
 */
export function getBudgetLedgerTotal(category?: string, sinceSqliteExpression?: string): number {
  const db = getDatabase();

  if (category && sinceSqliteExpression) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM budget_ledger
      WHERE category = ?
        AND timestamp >= ${sinceSqliteExpression}
    `).get(category) as { total: number };
    return Number(row.total ?? 0);
  }

  if (category) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM budget_ledger
      WHERE category = ?
    `).get(category) as { total: number };
    return Number(row.total ?? 0);
  }

  if (sinceSqliteExpression) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM budget_ledger
      WHERE timestamp >= ${sinceSqliteExpression}
    `).get() as { total: number };
    return Number(row.total ?? 0);
  }

  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS total
    FROM budget_ledger
  `).get() as { total: number };
  return Number(row.total ?? 0);
}

/**
 * Returns recent budget-ledger entries so dashboards and reinvestment reports can show the latest actions.
 */
export function getRecentBudgetLedgerEntries(limit = 50): BudgetLedgerRecord[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, category, amount_usd, operation, reference_id, metadata, timestamp
    FROM budget_ledger
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(limit) as BudgetLedgerRecord[];
}

/**
 * Stores one heartbeat summary row so the dashboard can show run history without parsing logs.
 */
export function recordHeartbeatLog(input: HeartbeatLogInsertInput): HeartbeatLogRecord {
  const db = getDatabase();
  const serializedErrors = Array.isArray(input.errors)
    ? JSON.stringify(input.errors)
    : (input.errors ?? null);

  const result = db.prepare(`
    INSERT INTO heartbeat_log (
      started_at,
      finished_at,
      opportunities_considered,
      designs_generated,
      listings_published,
      total_cost_usd,
      error_count,
      errors,
      claude_calls
    )
    VALUES (
      @started_at,
      @finished_at,
      @opportunities_considered,
      @designs_generated,
      @listings_published,
      @total_cost_usd,
      @error_count,
      @errors,
      @claude_calls
    )
  `).run({
    started_at: input.startedAt ?? null,
    finished_at: input.finishedAt ?? null,
    opportunities_considered: input.opportunitiesConsidered ?? 0,
    designs_generated: input.designsGenerated ?? 0,
    listings_published: input.listingsPublished ?? 0,
    total_cost_usd: input.totalCostUsd ?? 0,
    error_count: input.errorCount ?? 0,
    errors: serializedErrors,
    claude_calls: input.claudeCalls ?? 0,
  });

  return db.prepare(`
    SELECT id, started_at, finished_at, opportunities_considered, designs_generated, listings_published,
           total_cost_usd, error_count, errors, claude_calls, created_at
    FROM heartbeat_log
    WHERE id = ?
  `).get(result.lastInsertRowid) as HeartbeatLogRecord;
}

/**
 * Returns recent heartbeat runs for dashboards and operational review.
 */
export function getRecentHeartbeatLogs(limit = 10): HeartbeatLogRecord[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, started_at, finished_at, opportunities_considered, designs_generated, listings_published,
           total_cost_usd, error_count, errors, claude_calls, created_at
    FROM heartbeat_log
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as HeartbeatLogRecord[];
}

/**
 * Creates or refreshes a shop section mapping so listings can be assigned to stable Etsy section IDs.
 */
export function upsertShopSection(etsySectionId: string | number, title: string): ShopSectionRecord {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO shop_sections (etsy_section_id, title)
    VALUES (?, ?)
    ON CONFLICT(etsy_section_id) DO UPDATE SET
      title = excluded.title
  `).run(String(etsySectionId), title);

  return db.prepare(`
    SELECT id, etsy_section_id, title, created_at
    FROM shop_sections
    WHERE etsy_section_id = ?
  `).get(String(etsySectionId)) as ShopSectionRecord;
}

/**
 * Returns all stored shop sections so listing generation and maintenance jobs can reuse them.
 */
export function getShopSections(): ShopSectionRecord[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, etsy_section_id, title, created_at
    FROM shop_sections
    ORDER BY title COLLATE NOCASE ASC
  `).all() as ShopSectionRecord[];
}

/**
 * Finds one stored shop section by title using a case-insensitive exact match.
 */
export function findShopSectionByTitle(title: string): ShopSectionRecord | null {
  const db = getDatabase();
  return (db.prepare(`
    SELECT id, etsy_section_id, title, created_at
    FROM shop_sections
    WHERE lower(title) = lower(?)
    LIMIT 1
  `).get(title) as ShopSectionRecord | undefined) ?? null;
}

/**
 * Totals today's design-generation spend so budget caps can block new image jobs before they overspend.
 */
export function getDailyDesignSpend(): number {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM designs
    WHERE created_at >= datetime('now', 'start of day')
  `).get() as { total: number };
  return Number(row.total ?? 0);
}

/**
 * Totals the trailing seven days of marketing spend so weekly channel budgets can be enforced.
 */
export function getWeeklyMarketingSpend(): number {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM marketing_events
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { total: number };
  return Number(row.total ?? 0);
}

/**
 * Returns unresolved dead-letter rows that still have retry attempts available.
 */
export function getRetryableFailedOperations(limit = 100): FailedOperationRecord[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  const safeLimit = Math.max(0, Math.min(normalizedLimit, 500));
  if (safeLimit === 0) {
    return [];
  }

  const db = getDatabase();
  return db.prepare(`
    SELECT
      id,
      operation_type,
      listing_id,
      design_id,
      payload,
      error,
      attempts,
      last_attempted_at,
      resolved_at,
      created_at
    FROM failed_operations
    WHERE resolved_at IS NULL
      AND attempts < 5
    ORDER BY
      last_attempted_at IS NOT NULL ASC,
      datetime(COALESCE(last_attempted_at, created_at)) ASC,
      id ASC
    LIMIT ?
  `).all(safeLimit) as FailedOperationRecord[];
}

/**
 * Records one provider health snapshot for the balance monitor and dashboard.
 */
export function recordProviderHealth(provider: string, status: string, latencyMs: number | null): ProviderHealthStatusRecord {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedStatus = status.trim().toLowerCase();
  if (!normalizedProvider) {
    throw new Error("Provider health record requires a provider name.");
  }
  if (!normalizedStatus) {
    throw new Error(`Provider health record for ${normalizedProvider} requires a status.`);
  }

  const db = getDatabase();
  const normalizedLatencyMs = latencyMs === null || !Number.isFinite(latencyMs)
    ? null
    : Math.max(0, Math.round(latencyMs));
  const result = db.prepare(`
    INSERT INTO provider_health (provider, status, latency_ms)
    VALUES (?, ?, ?)
  `).run(
    normalizedProvider,
    normalizedStatus,
    normalizedLatencyMs,
  );

  return db.prepare(`
    SELECT id, provider, status, latency_ms, created_at
    FROM provider_health
    WHERE id = ?
  `).get(result.lastInsertRowid) as ProviderHealthStatusRecord;
}

/**
 * Stores one Income Generator (IGM) status snapshot so passive bandwidth income can be reported alongside Etsy income.
 */
export function recordIgmSnapshot(input: IgmSnapshotInput): IgmSnapshotRecord {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO igm_snapshots (status, running_apps, total_apps, earnings_usd, currency, detail)
    VALUES (@status, @running_apps, @total_apps, @earnings_usd, @currency, @detail)
  `).run({
    status: input.status,
    running_apps: Math.max(0, Math.trunc(input.runningApps)),
    total_apps: Math.max(0, Math.trunc(input.totalApps)),
    earnings_usd: input.earningsUsd == null || !Number.isFinite(input.earningsUsd) ? null : input.earningsUsd,
    currency: input.currency?.trim() || "USD",
    detail: serializeMetadata(input.detail),
  });

  return db.prepare(`
    SELECT id, status, running_apps, total_apps, earnings_usd, currency, detail, created_at
    FROM igm_snapshots
    WHERE id = ?
  `).get(result.lastInsertRowid) as IgmSnapshotRecord;
}

/**
 * Returns the most recent IGM snapshot, or null when no snapshot has been recorded yet.
 */
export function getLatestIgmSnapshot(): IgmSnapshotRecord | null {
  const db = getDatabase();
  return (db.prepare(`
    SELECT id, status, running_apps, total_apps, earnings_usd, currency, detail, created_at
    FROM igm_snapshots
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as IgmSnapshotRecord | undefined) ?? null;
}

/**
 * Returns the most recent reported IGM earnings figure (cumulative as reported by the apps), or null when none exists.
 */
export function getLatestIgmEarnings(): { earningsUsd: number; currency: string; recordedAt: string } | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT earnings_usd, currency, created_at
    FROM igm_snapshots
    WHERE earnings_usd IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { earnings_usd: number; currency: string; created_at: string } | undefined;

  if (!row) {
    return null;
  }
  return { earningsUsd: Number(row.earnings_usd), currency: row.currency, recordedAt: row.created_at };
}

/**
 * Returns the newest provider health row per provider, keyed by provider name.
 */
export function getLatestProviderHealthStatuses(): Record<string, ProviderHealthStatusRecord> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT id, provider, status, latency_ms, created_at
    FROM provider_health
    WHERE id IN (
      SELECT MAX(id)
      FROM provider_health
      GROUP BY provider
    )
    ORDER BY provider COLLATE NOCASE ASC
  `).all() as ProviderHealthStatusRecord[];

  return Object.fromEntries(rows.map((row) => [row.provider, row]));
}

/**
 * Upserts a runtime control flag so autonomous safety rails can pause or resume parts of the system.
 */
export function setAutomationControl(key: string, value: string, reason?: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO automation_controls (key, value, reason, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value, reason ?? null);
}

/**
 * Reads a runtime control flag so orchestration code can honor persisted pause states.
 */
export function getAutomationControl(key: string): AutomationControlRecord | null {
  const db = getDatabase();
  const statement = db.prepare(`
    SELECT key, value, reason, updated_at
    FROM automation_controls
    WHERE key = ?
  `);
  return (statement.get(key) as AutomationControlRecord | undefined) ?? null;
}

/**
 * Returns whether publishing is currently paused by a safety rail or operator override.
 */
export function isPublishingPaused(): boolean {
  const control = getAutomationControl("publishing_paused");
  return control?.value === "true";
}

/**
 * Persists a publishing pause so future orchestrator runs stop before new products go live.
 */
export function pausePublishing(reason: string): void {
  setAutomationControl("publishing_paused", "true", reason);
}

/**
 * Clears a publishing pause when an operator or a recovery workflow decides the system can resume.
 */
export function clearPublishingPause(reason = "Publishing resumed"): void {
  setAutomationControl("publishing_paused", "false", reason);
}
