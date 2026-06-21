import "dotenv/config";

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ListingRecord,
  NicheRecord,
  createDraftListing,
  getActiveNiches,
  getDatabase,
  getRecentResearchResultsForNiche,
  getShopSections,
  initializeDatabase,
  markListingEtsyMissing,
} from "../lib/db.js";
import { fetchRelatedKeywords } from "../lib/datamuse-client.js";
import { updateListingTags } from "../lib/etsy-client.js";
import { appendAiDisclosure, assertLegalApproval } from "../lib/legal-filter.js";
import { callLLM } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";
import {
  ENAMEL_PIN_FULFILLMENT_NOTE,
  PRODUCT_BASE_PRICES,
  getProductDisplayName,
  normalizeProductType,
  type ProductType,
} from "../lib/product-types.js";
import { buildDeterministicId, isDryRunEnabled } from "../lib/runtime.js";

export interface ListingGenerationInput {
  nicheId?: number;
  nicheName?: string;
  keyword: string;
  designId?: number;
  productType?: string;
}

interface PromptBundle {
  title: string;
  description: string;
  tags: string;
}

interface ListingCopyBundleResponse {
  title: string;
  description: string;
  tags: string[];
}

const logger = createLogger("listing-gen");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Removes optional Markdown fences from model output before JSON parsing.
 */
function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Returns a fully validated synthetic listing so dry-run checks can exercise downstream orchestration safely.
 */
function buildDryRunListing(input: ListingGenerationInput): ListingRecord {
  const productType = normalizeProductType(input.productType);
  const productLabel = getProductDisplayName(productType);
  const title = `${input.keyword} Vintage Inspired ${productLabel}`.slice(0, 140);
  const description = [
    `${input.keyword} leads this dry-run Etsy description so the SEO path stays representative without calling a model for this ${productLabel}.`,
    "Jarvis uses this synthetic copy to confirm listing generation, routing, and validation rules are wired correctly before any live provider traffic is allowed.",
    "The product summary stays comfortably above the quality threshold, includes a natural buyer-facing tone, and mirrors the structure the live Claude prompt is expected to create.",
    "Use this placeholder record only for smoke testing. It should never be published, charged, synced, or treated as real marketplace content.",
  ].join(" ");
  const tags = [
    input.keyword.slice(0, 20),
    "retro decor",
    "nostalgia gift",
    "digital art",
    "instant download",
    "home office",
    "gift for her",
    "gift for him",
    "wall art print",
    "vintage style",
    "y2k aesthetic",
    "etsy seo test",
    "jarvis dry run",
  ];

  return {
    id: buildDeterministicId(`listing:${input.keyword}:${input.productType ?? "generic"}`),
    niche_id: input.nicheId ?? 1,
    title,
    description,
    tags: tags.join(", "),
    price: productType ? PRODUCT_BASE_PRICES[productType] : 14.99,
    image_url: null,
    etsy_listing_id: null,
    status: "draft",
    created_at: new Date().toISOString(),
    published_at: null,
    design_id: input.designId ?? null,
    product_type: productType,
    quality_score: 0.92,
    printify_product_id: null,
    printful_product_id: null,
    ai_assisted_tag: "AI-assisted design",
    metadata: JSON.stringify({
      dryRun: true,
      keyword: input.keyword,
      source: "listing-gen",
    }),
  };
}

/**
 * Loads the three prompt templates used to generate Etsy-ready listing copy.
 */
async function loadPromptTemplates(): Promise<PromptBundle> {
  const promptsDirectory = resolve(projectRoot, "data", "prompts");
  const [title, description, tags] = await Promise.all([
    readFile(resolve(promptsDirectory, "listing_title.txt"), "utf8"),
    readFile(resolve(promptsDirectory, "listing_description.txt"), "utf8"),
    readFile(resolve(promptsDirectory, "listing_tags.txt"), "utf8"),
  ]);

  return { title, description, tags };
}

/**
 * Replaces handlebars-style placeholders so the template files can stay clean and editable.
 */
function renderTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

/**
 * Returns the product-specific copy guidance so generated listings describe the actual item, not a generic product shell.
 */
function buildProductCopyGuidance(productType: ProductType | null): string {
  switch (productType) {
    case "sticker":
      return "Focus on die-cut sticker use cases, waterproof vinyl language, and laptop, bottle, notebook, or gear placement.";
    case "t-shirt":
      return "Describe a wearable graphic tee with a premium unisex fit, crisp chest print, and everyday apparel use.";
    case "mug":
      return "Describe an 11oz mug with wrap-around artwork, everyday coffee or desk use, and a giftable made-to-order feel.";
    case "poster":
      return "Describe an 18x24 portrait poster with high-detail wall-art presentation, framing compatibility, and room styling context.";
    case "hoodie":
      return "Describe a premium hoodie with a bold chest print, optional back-print feel, and cozy made-to-order apparel positioning.";
    case "enamel-pin":
      return `Describe a made-to-order enamel pin with a bold icon, collector appeal, jacket or bag placement, and include this exact note once: "${ENAMEL_PIN_FULFILLMENT_NOTE}"`;
    default:
      return "Describe the item clearly, keep it buyer-friendly, and make the product type unmistakable throughout the copy.";
  }
}

/**
 * Applies required product-specific fulfillment notes before the AI disclosure is appended.
 */
function appendProductFulfillmentNote(description: string, productType: ProductType | null): string {
  if (productType === "enamel-pin" && !description.includes(ENAMEL_PIN_FULFILLMENT_NOTE)) {
    return `${description}\n\n${ENAMEL_PIN_FULFILLMENT_NOTE}`;
  }
  return description;
}

/**
 * Returns the fixed base price for supported product types so pricing stays consistent across the pipeline.
 */
function resolveListingPrice(productType: ProductType | null): number {
  return productType ? PRODUCT_BASE_PRICES[productType] : 14.99;
}

/**
 * Resolves a niche from CLI or orchestrator input while keeping human-readable names supported.
 */
function resolveNiche(input: ListingGenerationInput): NicheRecord {
  const activeNiches = getActiveNiches();

  if (input.nicheId) {
    const byId = activeNiches.find((niche) => niche.id === input.nicheId);
    if (byId) {
      return byId;
    }
  }

  if (input.nicheName) {
    const byName = activeNiches.find((niche) => niche.name.toLowerCase() === input.nicheName?.toLowerCase());
    if (byName) {
      return byName;
    }
  }

  throw new Error("Unable to resolve the requested niche from the active niche list.");
}

/**
 * Extracts recent pricing and competition context so Claude has market-aware guidance.
 */
function buildResearchContext(nicheId: number): {
  averagePrice: number;
  competitionLevel: string;
  estimatedDemand: string;
  realPersonFlag: boolean;
  manualReviewReason: string | null;
} {
  const recentResults = getRecentResearchResultsForNiche(nicheId, 1);
  if (recentResults.length === 0) {
    return {
      averagePrice: 12.99,
      competitionLevel: "unknown",
      estimatedDemand: "unknown",
      realPersonFlag: false,
      manualReviewReason: null,
    };
  }

  const latest = recentResults[0];
  const parsed = JSON.parse(stripMarkdownFences(latest.raw_data)) as {
    averagePrice?: number;
    competitionLevel?: string;
    estimatedDemand?: string;
    real_person_flag?: boolean;
    manual_review_reason?: string | null;
  };

  return {
    averagePrice: Number(parsed.averagePrice ?? 12.99),
    competitionLevel: latest.competition_level ?? parsed.competitionLevel ?? "unknown",
    estimatedDemand: latest.estimated_demand ?? parsed.estimatedDemand ?? "unknown",
    realPersonFlag: parsed.real_person_flag === true,
    manualReviewReason: parsed.manual_review_reason ?? null,
  };
}

/**
 * Parses Claude's comma-separated tag output into a normalized array of unique tags.
 */
function parseTags(rawTags: string): string[] {
  const uniqueTags = new Set<string>();

  for (const tag of rawTags.split(",")) {
    const normalizedTag = tag.trim();
    if (!normalizedTag) {
      continue;
    }
    uniqueTags.add(normalizedTag);
  }

  return [...uniqueTags];
}

/**
 * Truncates one Etsy tag at the last full word that fits within 20 characters, with a hard fallback when needed.
 */
function truncateTagToFit(tag: string): string {
  const trimmed = tag.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 20) {
    return trimmed;
  }

  const words = trimmed.split(" ");
  let candidate = "";
  for (const word of words) {
    const nextCandidate = candidate ? `${candidate} ${word}` : word;
    if (nextCandidate.length > 20) {
      break;
    }
    candidate = nextCandidate;
  }

  if (candidate.length > 0) {
    return candidate;
  }

  return trimmed.slice(0, 20).trim();
}

/**
 * Enforces Etsy's 20-character tag limit while preserving as much semantic value as possible.
 */
export function validateTags(tags: string[]): string[] {
  const normalizedTags = tags
    .map((tag) => tag.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const valid: string[] = [];
  const seen = new Set<string>();
  const longTags: string[] = [];

  for (const tag of normalizedTags) {
    if (tag.length <= 20) {
      const key = tag.toLowerCase();
      if (seen.has(key)) {
        logger.debug("Dropping duplicate Etsy tag.", { tag });
        continue;
      }
      seen.add(key);
      valid.push(tag);
      continue;
    }

    longTags.push(tag);
  }

  if (valid.length < 13) {
    for (const tag of longTags) {
      const truncated = truncateTagToFit(tag);
      if (!truncated) {
        logger.debug("Dropping Etsy tag because no valid truncated form was available.", { tag });
        continue;
      }

      const key = truncated.toLowerCase();
      if (seen.has(key)) {
        logger.debug("Dropping Etsy tag because truncation produced a duplicate.", {
          originalTag: tag,
          truncatedTag: truncated,
        });
        continue;
      }

      seen.add(key);
      valid.push(truncated);
      logger.debug("Truncated Etsy tag to fit 20-character limit.", {
        originalTag: tag,
        truncatedTag: truncated,
      });

      if (valid.length >= 13) {
        break;
      }
    }
  }

  for (const tag of longTags) {
    if (valid.length >= 13) {
      logger.debug("Dropped Etsy tag after 13 valid tags were already available.", { tag });
    }
  }

  return valid.slice(0, 13);
}

/**
 * Generates title, description, and tags in one structured call so listing generation stays cheaper and more consistent.
 *
 * Related buyer-search terms (from the keyless Datamuse API) are offered to the model as curated candidates;
 * the model picks the relevant, on-brand ones for tags and ignores any off-topic noise, so the linguistic
 * source never writes directly to a brand-facing listing.
 */
async function generateListingCopyBundle(
  templates: PromptBundle,
  niche: NicheRecord,
  keyword: string,
  productType: ProductType | null,
): Promise<{ title: string; description: string; tags: string[]; claudeCalls: number }> {
  const productLabel = getProductDisplayName(productType);
  const relatedKeywords = await fetchRelatedKeywords(keyword, { max: 20 });
  const relatedGuidance = relatedKeywords.length > 0
    ? [
        "",
        "RELATED BUYER SEARCH TERMS (optional candidates — use only the relevant, on-brand ones as tags; ignore anything off-topic or inappropriate):",
        relatedKeywords.join(", "),
      ]
    : [];

  const prompt = [
    "You are generating a complete Etsy listing package.",
    "Return valid JSON only with the shape:",
    '{"title":"string","description":"string","tags":["tag1","tag2"]}',
    "",
    "Follow these exact guidance templates:",
    "",
    "TITLE TEMPLATE:",
    renderTemplate(templates.title, { niche: niche.name, keyword }),
    "",
    "DESCRIPTION TEMPLATE:",
    renderTemplate(templates.description, { title: "{{title}}", niche: niche.name, keyword }),
    "",
    "TAGS TEMPLATE:",
    renderTemplate(templates.tags, { title: "{{title}}", niche: niche.name, keyword }),
    ...relatedGuidance,
    "",
    "Requirements:",
    `- the product type is ${productLabel}`,
    `- ${buildProductCopyGuidance(productType)}`,
    "- title max 140 chars",
    "- description 300-500 words",
    "- tags array must contain exactly 13 entries",
    "- each tag max 20 chars",
    "- no markdown fences",
  ].join("\n");

  const response = await callLLM({
    taskType: "listing_copywriting",
    prompt,
    maxTokens: 1_600,
    temperature: 0.55,
    expectJson: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(response.text ?? "{}")) as ListingCopyBundleResponse;
  return {
    title: String(parsed.title ?? "").trim(),
    description: String(parsed.description ?? "").trim(),
    tags: validateTags(Array.isArray(parsed.tags) ? parseTags(parsed.tags.join(",")) : parseTags(String(parsed.tags ?? ""))),
    claudeCalls: response.provider === "claude" ? 1 : 0,
  };
}

/**
 * Maps product types to the best available Etsy shop section title and ID saved by shop setup.
 */
function resolveSuggestedShopSection(productType: string | undefined): { title: string | null; etsySectionId: string | null } {
  const sections = getShopSections();
  const normalizedProductType = normalizeProductType(productType);
  if (sections.length === 0 || !normalizedProductType) {
    return { title: null, etsySectionId: null };
  }

  const preferredTitles = normalizedProductType === "t-shirt" || normalizedProductType === "hoodie"
    ? ["Veteran Culture", "Signal & Noise", "Tees", "T-Shirts", "Hoodies"]
    : normalizedProductType === "poster"
      ? ["Cybersecurity & Tech", "Retro Posters", "Posters", "Wall Art"]
      : normalizedProductType === "mug"
        ? ["Veteran Culture", "Gifts", "Mugs"]
        : normalizedProductType === "enamel-pin"
          ? ["Law Enforcement", "Gifts", "Accessories", "Pins"]
          : ["Veteran Culture", "Gifts", "Stickers", "Stickers & Mugs"];

  const match = sections.find((section) => preferredTitles.some((title) => section.title.toLowerCase() === title.toLowerCase()))
    ?? sections.find((section) => preferredTitles.some((title) => section.title.toLowerCase().includes(title.toLowerCase())))
    ?? sections[0];

  return {
    title: match?.title ?? null,
    etsySectionId: match ? String(match.etsy_section_id) : null,
  };
}

/**
 * Validates core Etsy listing constraints before the draft is written to the database.
 */
function validateGeneratedListing(title: string, description: string, tags: string[], price: number): void {
  const wordCount = description.trim().split(/\s+/).filter(Boolean).length;

  if (!title || title.length > 140) {
    throw new Error("Generated title is empty or exceeds Etsy's 140-character limit.");
  }

  if (description.length < 200 || wordCount < 250) {
    throw new Error("Generated description is too short for the Jarvis quality threshold.");
  }

  if (tags.length < 1 || tags.length > 13) {
    throw new Error(`Generated tags were invalid. Expected between 1 and 13 tags, received ${tags.length}.`);
  }

  if (tags.some((tag) => tag.length < 1 || tag.length > 20)) {
    throw new Error("At least one generated tag exceeds Etsy's 20-character limit.");
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Generated suggested price was not a positive number.");
  }
}

/**
 * Generates a complete listing draft and persists it locally for later image generation and publishing.
 */
export async function generateListing(input: ListingGenerationInput): Promise<ListingRecord> {
  if (isDryRunEnabled()) {
    const listing = buildDryRunListing(input);
    logger.action("Dry-run listing generation completed", "skip", {
      keyword: input.keyword,
      listingId: listing.id,
    });
    return listing;
  }

  initializeDatabase();
  const niche = resolveNiche(input);
  const templates = await loadPromptTemplates();
  const researchContext = buildResearchContext(niche.id);
  const productType = normalizeProductType(input.productType);
  const suggestedSection = resolveSuggestedShopSection(productType ?? undefined);

  logger.action("Generating listing copy with Claude", "start", {
    nicheId: niche.id,
    niche: niche.name,
    keyword: input.keyword,
  });
  const copyBundle = await generateListingCopyBundle(templates, niche, input.keyword, productType);
  const title = copyBundle.title;
  const description = appendProductFulfillmentNote(copyBundle.description, productType);
  const disclosedDescription = appendAiDisclosure(description);
  const tags = copyBundle.tags;

  const price = resolveListingPrice(productType);
  const claudeCallCount = copyBundle.claudeCalls;

  await assertLegalApproval({
    theme: input.keyword,
    title,
    description: disclosedDescription,
    tags,
    realPersonFlag: researchContext.realPersonFlag,
    source: "listing-gen:copy",
  }, "copy");

  validateGeneratedListing(title, disclosedDescription, tags, price);

  const listing = createDraftListing({
    nicheId: niche.id,
    title,
    description: disclosedDescription,
    tags,
    price: Number(price.toFixed(2)),
    designId: input.designId ?? null,
    productType,
    metadata: {
      source: "listing-gen",
      keyword: input.keyword,
      realPersonFlag: researchContext.realPersonFlag,
      requiresManualReview: researchContext.realPersonFlag,
      manualReviewReason: researchContext.manualReviewReason,
      claudeCallCount,
      suggestedShopSectionTitle: suggestedSection.title,
      suggestedShopSectionId: suggestedSection.etsySectionId,
      videoThumbnailPrompt: `Short animated mockup concept for ${title}: gentle product pan, bold retro typography, and a clear lifestyle framing for future video pins.`,
    },
  });

  logger.action("Listing draft saved to SQLite", "success", {
    listingId: listing.id,
    title: listing.title,
    claudeCallCount,
  });
  return listing;
}

/**
 * Refreshes tags on older low-view listings so stagnant SEO terms can be swapped without rebuilding the full listing.
 */
export async function refreshLowViewListingTags(): Promise<number> {
  if (isDryRunEnabled()) {
    return 0;
  }

  initializeDatabase();
  const db = getDatabase();
  const templates = await loadPromptTemplates();
  const staleListings = db.prepare(`
    SELECT
      l.id,
      l.title,
      l.tags,
      l.etsy_listing_id,
      l.product_type,
      n.name AS niche_name,
      COALESCE(MAX(a.views), 0) AS latest_views
    FROM listings l
    LEFT JOIN niches n ON n.id = l.niche_id
    LEFT JOIN analytics a ON a.listing_id = l.id
    WHERE l.created_at <= datetime('now', '-30 days')
      AND l.status = 'published'
    GROUP BY l.id, l.title, l.tags, l.etsy_listing_id, l.product_type, n.name
    HAVING latest_views < 10
    LIMIT 10
  `).all() as Array<{
    id: number;
    title: string;
    tags: string;
    etsy_listing_id: string | null;
    product_type: string | null;
    niche_name: string | null;
    latest_views: number;
  }>;

  let refreshed = 0;
  for (const listing of staleListings) {
    try {
      const keyword = listing.title.split(/\s+/).slice(0, 5).join(" ");
      const tags = validateTags(parseTags(
        (
          await callLLM({
            taskType: "listing_copywriting",
            prompt: renderTemplate(templates.tags, {
              title: listing.title,
              niche: listing.niche_name ?? listing.product_type ?? "retro gifts",
              keyword,
            }),
            maxTokens: 180,
            temperature: 0.45,
          })
        ).text ?? "",
      ));

      if (tags.length < 1 || tags.length > 13) {
        continue;
      }

      db.prepare(`UPDATE listings SET tags = ? WHERE id = ?`).run(tags.join(","), listing.id);
      if (listing.etsy_listing_id) {
        await updateListingTags(listing.etsy_listing_id, tags);
      }
      refreshed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        markListingEtsyMissing(listing.id);
        logger.action("Marked listing as failed; Etsy returned 404 during tag refresh", "skip", {
          listingId: listing.id,
          etsyListingId: listing.etsy_listing_id,
        });
      } else {
        logger.error("Failed to refresh tags for a low-view listing", error, { listingId: listing.id });
      }
    }
  }

  return refreshed;
}

/**
 * Reads CLI arguments for the standalone listing generation entry point.
 */
function parseCliArgs(argv: string[]): ListingGenerationInput {
  const nicheIdIndex = argv.findIndex((argument) => argument === "--niche-id");
  const nicheNameIndex = argv.findIndex((argument) => argument === "--niche");
  const keywordIndex = argv.findIndex((argument) => argument === "--keyword");
  const designIdIndex = argv.findIndex((argument) => argument === "--design-id");
  const productTypeIndex = argv.findIndex((argument) => argument === "--product-type");

  const nicheId = nicheIdIndex >= 0 ? Number.parseInt(argv[nicheIdIndex + 1] ?? "", 10) : undefined;
  const nicheName = nicheNameIndex >= 0 ? argv[nicheNameIndex + 1] : undefined;
  const keyword = keywordIndex >= 0 ? argv[keywordIndex + 1] : undefined;
  const designId = designIdIndex >= 0 ? Number.parseInt(argv[designIdIndex + 1] ?? "", 10) : undefined;
  const productType = productTypeIndex >= 0 ? argv[productTypeIndex + 1] : undefined;

  if (!keyword) {
    throw new Error("Missing required --keyword argument for listing generation.");
  }

  return {
    nicheId: Number.isFinite(nicheId) ? nicheId : undefined,
    nicheName,
    keyword,
    designId: Number.isFinite(designId) ? designId : undefined,
    productType,
  };
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone listing generation entry point and prints the created database record.
 */
async function main(): Promise<void> {
  try {
    const input = parseCliArgs(process.argv.slice(2));
    const listing = await generateListing(input);
    console.log(JSON.stringify(listing, null, 2));
  } catch (error) {
    logger.error("Standalone listing generation failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
