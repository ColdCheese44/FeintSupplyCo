import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDraftListing as createLocalDraftListing,
  getActiveNiches,
  getShopSections,
  initializeDatabase,
  markListingPublished,
  resolveProjectPath,
  updateListingImagePath,
  updateListingStatus,
  upsertShopSection,
  type ListingRecord,
  type NicheRecord,
} from "../lib/db.js";
import { generateStickerDesign } from "../lib/brand-compositor.js";
import { recordFailure } from "../lib/dead-letter.js";
import {
  activateListing,
  createListing as createEtsyListing,
  createShopSection,
  getShippingProfiles,
  listShopSections,
  updateListingSection,
  uploadListingImage,
} from "../lib/etsy-client.js";
import { appendAiDisclosure } from "../lib/legal-filter.js";
import { callLLM } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";
import { resolveAssetPath, toRelativePath } from "../lib/paths.js";
import { uploadToImgbb } from "../lib/imgbb-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { validateTags } from "../skills/listing-gen.js";

interface StickerScriptOptions {
  dryRun: boolean;
}

interface StickerDesignSpec {
  id: number;
  name: string;
  concept: string;
}

interface StickerListingCopyResponse {
  title: string;
  description: string;
  tags: string[];
}

interface StickerRunItem {
  designId: number;
  name: string;
  listingId?: number;
  etsyListingId?: string;
  localDesignPath?: string;
  provider?: "etsy";
  published: boolean;
  errors: string[];
}

interface StickerRunResult {
  dryRun: boolean;
  generatedAt: string;
  publishedCount: number;
  items: StickerRunItem[];
}

const logger = createLogger("generate-sticker-pack");
const stickerRoot = resolveProjectPath("data/stickers");
const defaultStickerTags = [
  "sticker",
  "feint supply",
  "veteran owned",
  "cybersecurity",
  "tactical",
  "die cut sticker",
  "vinyl sticker",
  "dark aesthetic",
  "operator",
  "laptop sticker",
];

const stickerDesigns: StickerDesignSpec[] = [
  {
    id: 1,
    name: "Wordmark",
    concept: "Rectangular wordmark sticker with FEINT SUPPLY CO. framed by clean cyan rules on a dark field.",
  },
  {
    id: 2,
    name: "Signal Phrase",
    concept: "Minimal signal phrase sticker featuring SIGNAL OVER NOISE. with an amber chevron accent.",
  },
  {
    id: 3,
    name: "Tagline",
    concept: "Stacked brand tagline sticker with BUILT DIFFERENT. above BY PEOPLE WHO WERE.",
  },
  {
    id: 4,
    name: "FSC Badge",
    concept: "Circular FSC badge in the logo-icon aesthetic with a clean cyan border and dark core.",
  },
  {
    id: 5,
    name: "Chevron Mark",
    concept: "Bold amber chevron sticker with FEINT beneath it in a restrained badge treatment.",
  },
  {
    id: 6,
    name: "Redacted",
    concept: "Dark humor redacted document sticker with a CLASSIFIED overlay and investigator tone.",
  },
  {
    id: 7,
    name: "Alert Status",
    concept: "Terminal-style operational status sticker with green text on a near-black panel.",
  },
  {
    id: 8,
    name: "After Action",
    concept: "After action report sticker with SURVIVED ANOTHER ONE as the understated subtitle.",
  },
  {
    id: 9,
    name: "Operationally Sound",
    concept: "Dry delivery typography sticker with OPERATIONALLY SOUND. and EMOTIONALLY QUESTIONABLE.",
  },
  {
    id: 10,
    name: "Grid Mark",
    concept: "Coordinate grid sticker with cyan crosshairs and an amber FSC center mark.",
  },
];

/**
 * Removes optional Markdown fences from LLM JSON responses before parsing.
 */
function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Returns whether generated sticker listings should pause for manual approval instead of publishing.
 */
function requiresApproval(): boolean {
  return (process.env.REQUIRE_APPROVAL ?? "").trim().toLowerCase() === "true";
}

/**
 * Posts the final Discord summary only after a live run, never during preview mode.
 */
async function postDiscordSummary(message: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    logger.warn("Discord webhook URL missing; sticker summary was not posted.", { message });
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: process.env.DISCORD_BOT_NAME?.trim() || "Jarvis",
      content: message,
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord sticker summary failed: ${response.status} ${response.statusText} - ${await response.text()}`);
  }
}

/**
 * Picks the best niche bucket available for the permanent sticker catalog.
 */
function resolveStickerNiche(): NicheRecord {
  const activeNiches = getActiveNiches();
  const preferredNames = [
    "Minimal Dark Aesthetic",
    "Veteran Owned Brand",
    "Cybersecurity Culture",
    "Quiet Professional",
  ];

  for (const name of preferredNames) {
    const match = activeNiches.find((niche) => niche.name.toLowerCase() === name.toLowerCase());
    if (match) {
      return match;
    }
  }

  if (activeNiches.length === 0) {
    throw new Error("No active niches were available for the sticker collection.");
  }

  return activeNiches[0];
}

/**
 * Ensures the Stickers shop section exists and returns its Etsy section ID when running live.
 */
async function ensureStickerSection(dryRun: boolean): Promise<string> {
  if (dryRun) {
    return "preview-stickers";
  }

  const existingLocal = getShopSections().find((section) => section.title.toLowerCase() === "stickers");
  if (existingLocal) {
    return String(existingLocal.etsy_section_id);
  }

  const existingRemote = await listShopSections();
  const remoteMatch = existingRemote.find((section) => section.title.toLowerCase() === "stickers");
  if (remoteMatch) {
    upsertShopSection(remoteMatch.shop_section_id, remoteMatch.title);
    return String(remoteMatch.shop_section_id);
  }

  const created = await createShopSection("Stickers");
  upsertShopSection(created.shop_section_id, created.title);
  return String(created.shop_section_id);
}

/**
 * Uses Claude to generate sticker copy as one JSON payload so all permanent catalog listings stay on-brand and consistent.
 */
async function generateStickerListingCopy(spec: StickerDesignSpec): Promise<StickerListingCopyResponse> {
  const prompt = [
    "Return valid JSON only with the shape:",
    '{"title":"string","description":"string","tags":["tag1","tag2"]}',
    "",
    `Generate Etsy listing copy for a Feint Supply Co. branded die-cut sticker called "${spec.name}".`,
    `Design concept: ${spec.concept}`,
    "",
    "Requirements:",
    `- title must be exactly styled like: Feint Supply Co. - ${spec.name} Sticker`,
    "- description must be 150-200 words",
    "- description should reference the design concept, die-cut quality, weatherproof vinyl, and use cases like laptop, bottle, or gear",
    "- include the AI-assisted design disclosure sentence exactly once",
    "- tags should center on: sticker, feint supply, veteran owned, cybersecurity, tactical, die cut sticker, vinyl sticker, dark aesthetic, operator, laptop sticker",
    "- every tag must be 20 characters or fewer",
    "- no markdown fences",
  ].join("\n");

  const response = await callLLM({
    taskType: "listing_copywriting",
    prompt,
    maxTokens: 900,
    temperature: 0.45,
    expectJson: true,
  });

  const parsed = JSON.parse(stripMarkdownFences(response.text ?? "{}")) as StickerListingCopyResponse;
  const title = `Feint Supply Co. - ${spec.name} Sticker`;
  const description = appendAiDisclosure(
    `${String(parsed.description ?? "").trim()}\n\nPrinted and shipped via our fulfillment partner.\nStandard production time: 3-5 business days.`,
  );
  const tags = validateTags(Array.isArray(parsed.tags) ? parsed.tags : defaultStickerTags);

  return {
    title,
    description,
    tags,
  };
}

/**
 * Creates the local listing record that the live POD and Etsy publish flows reuse.
 */
function createStickerListingRecord(
  niche: NicheRecord,
  spec: StickerDesignSpec,
  copy: StickerListingCopyResponse,
  localDesignPath: string,
  stickerSectionId: string,
): ListingRecord {
  const listing = createLocalDraftListing({
    nicheId: niche.id,
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
    price: 4.99,
    productType: "sticker",
    metadata: {
      source: "generate-sticker-pack",
      collectionType: "permanent-branded-stickers",
      stickerDesignName: spec.name,
      suggestedShopSectionTitle: "Stickers",
      suggestedShopSectionId: stickerSectionId,
      stickerCollection: true,
      localDesignPath: toRelativePath(localDesignPath),
    },
  });

  updateListingImagePath(listing.id, localDesignPath);
  return listing;
}

/**
 * Reads the first available Etsy shipping profile so physical sticker listings can be created safely.
 */
async function getFirstShippingProfileId(dryRun: boolean): Promise<number | null> {
  if (dryRun) {
    return Number.parseInt(process.env.ETSY_SHIPPING_PROFILE_ID ?? "1", 10) || 1;
  }

  const profiles = await getShippingProfiles();
  const firstProfile = profiles[0];
  const profileId = firstProfile?.shipping_profile_id != null
    ? Number(firstProfile.shipping_profile_id)
    : null;
  if (!profileId) {
    logger.warn("No Etsy shipping profiles were found; sticker listing publish will be skipped.");
  }
  return profileId;
}

/**
 * Publishes a sticker listing directly to Etsy using the generated PNG and the first available shipping profile.
 */
export async function publishStickerDirect(localDesignPath: string, listing: ListingRecord, shopSectionId: string, dryRun: boolean): Promise<string> {
  const normalizedDesignPath = resolveAssetPath(localDesignPath);
  const imageUrl = dryRun ? "https://preview.local/sticker.png" : await uploadToImgbb(normalizedDesignPath);
  logger.info("Uploaded sticker design to imgbb", { imageUrl, listingId: listing.id });

  const shippingProfileId = await getFirstShippingProfileId(dryRun);
  if (!shippingProfileId) {
    throw new Error("No Etsy shipping profile is available. Add one in the Etsy dashboard before publishing sticker listings.");
  }

  if (dryRun) {
    return `dry-run-sticker-${listing.id}`;
  }

  const draft = await createEtsyListing({
    title: listing.title,
    description: listing.description,
    price: listing.price,
    tags: listing.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    quantity: 999,
    type: "physical",
    taxonomyId: 1,
    shippingProfileId,
  });

  await uploadListingImage(draft.listing_id, normalizedDesignPath);
  const publishResult = await activateListing(draft.listing_id);
  try {
    await updateListingSection(publishResult.etsyListingId, shopSectionId);
  } catch (error) {
    logger.warn("Section update failed — listing published without section", {
      etsyListingId: publishResult.etsyListingId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("Published sticker listing to Etsy", {
    etsyListingId: publishResult.etsyListingId,
    name: listing.title,
    imageUrl,
  });

  return publishResult.etsyListingId;
}

/**
 * Generates one branded sticker and, in live mode, publishes it directly to Etsy.
 */
async function processStickerDesign(spec: StickerDesignSpec, niche: NicheRecord, stickerSectionId: string, dryRun: boolean): Promise<StickerRunItem> {
  const item: StickerRunItem = {
    designId: spec.id,
    name: spec.name,
    published: false,
    errors: [],
  };

  try {
    const generatedAsset = await generateStickerDesign(spec.id);
    item.localDesignPath = generatedAsset.outputPath;

    const copy = await generateStickerListingCopy(spec);
    const listing = createStickerListingRecord(niche, spec, copy, generatedAsset.outputPath, stickerSectionId);
    item.listingId = listing.id;

    if (dryRun) {
      item.provider = "etsy";
      item.published = true;
      item.etsyListingId = `dry-run-sticker-${listing.id}`;
      return item;
    }

    if (requiresApproval()) {
      updateListingStatus(listing.id, "pending_approval", {
        ...(listing.metadata ? JSON.parse(listing.metadata) as Record<string, unknown> : {}),
        localDesignPath: toRelativePath(generatedAsset.outputPath),
        theme: spec.concept,
        approvalHeld: true,
      });
      item.provider = "etsy";
      item.published = false;
      return item;
    }

    const etsyListingId = await publishStickerDirect(generatedAsset.outputPath, listing, stickerSectionId, dryRun);
    markListingPublished(listing.id, etsyListingId);
    item.provider = "etsy";
    item.etsyListingId = etsyListingId;
    item.published = true;
    return item;
  } catch (error) {
    item.errors.push(error instanceof Error ? error.message : String(error));
    recordFailure(
      "publish",
      item.errors[item.errors.length - 1] ?? "Sticker collection item failed.",
      {
        designNumber: spec.id,
        designName: spec.name,
        localDesignPath: item.localDesignPath ? toRelativePath(item.localDesignPath) : null,
        listingId: item.listingId ?? null,
        source: "generate-sticker-pack",
      },
      item.listingId,
      spec.id,
    );
    logger.error("Sticker collection item failed", error, {
      designNumber: spec.id,
      designName: spec.name,
    });
    return item;
  }
}

/**
 * Runs the permanent Feint sticker collection generation flow in preview or live mode.
 */
export async function runStickerPack(options: StickerScriptOptions): Promise<StickerRunResult> {
  initializeDatabase();
  if (options.dryRun) {
    process.env.DRY_RUN = "true";
  }

  await mkdir(stickerRoot, { recursive: true });
  const niche = resolveStickerNiche();
  const dryRun = options.dryRun || isDryRunEnabled();
  const stickerSectionId = await ensureStickerSection(dryRun);
  const result: StickerRunResult = {
    dryRun,
    generatedAt: new Date().toISOString(),
    publishedCount: 0,
    items: [],
  };

  for (const spec of stickerDesigns) {
    const item = await processStickerDesign(spec, niche, stickerSectionId, dryRun);
    if (item.published) {
      result.publishedCount += 1;
    }
    result.items.push(item);
  }

  if (!dryRun) {
    await postDiscordSummary(`Feint Supply Co. sticker collection generated.\n${result.publishedCount} of 10 listings published to Etsy.`);
  }

  const reportPath = resolveProjectPath("data/stickers/sticker-collection-report.json");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  logger.action("Sticker collection run completed", "success", {
    dryRun: result.dryRun,
    publishedCount: result.publishedCount,
    reportPath,
  });
  return result;
}

/**
 * Parses CLI flags for preview mode.
 */
function parseCliArgs(argv: string[]): StickerScriptOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Detects direct execution so npm scripts can invoke the sticker generator cleanly.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Standalone entry point for the permanent sticker catalog flow.
 */
async function main(): Promise<void> {
  try {
    const result = await runStickerPack(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    recordFailure(
      "publish",
      error instanceof Error ? error.message : String(error),
      {
        source: "generate-sticker-pack:main",
        dryRun: parseCliArgs(process.argv.slice(2)).dryRun,
      },
    );
    logger.error("Standalone sticker generation failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
