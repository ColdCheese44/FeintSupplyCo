import "dotenv/config";

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callLLM } from "../lib/llm-router.js";
import { getDatabase, initializeDatabase, resolveProjectPath, upsertShopSection } from "../lib/db.js";
import { createShopSection, listShopSections, updateShopAboutStory, updateShopCore } from "../lib/etsy-client.js";
import { createLogger } from "../lib/logger.js";
import { ensureDryRunImage } from "../lib/runtime.js";

interface ShopContext {
  shop_name: string;
  tagline: string;
  primary_niches: string[];
  top_themes: string[];
  product_types: string[];
  style: string;
}

interface ShopCopyPayload {
  title: string;
  announcement: string;
  sale_message: string;
  policy_welcome: string;
  policy_payment: string;
  policy_shipping: string;
  policy_refunds: string;
  policy_additional: string;
  sections: string[];
  about_story: string;
  about_headline: string;
  faq: Array<{ question: string; answer: string }>;
}

interface ShopSetupLog {
  setup_complete: boolean;
  last_run_at: string;
  last_refresh_at?: string;
  manual_actions: string[];
  sections: Array<{ title: string; etsy_section_id?: string }>;
}

interface ShopSetupOptions {
  dryRun?: boolean;
  refreshOnly?: boolean;
}

const logger = createLogger("shop-setup");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shopDir = resolveProjectPath("data/shop");
const setupLogPath = resolve(shopDir, "setup-log.json");
const shopConfigPath = resolve(shopDir, "shop-config.json");
const aboutStoryPath = resolve(shopDir, "about-story.txt");
const faqPath = resolve(shopDir, "faq.txt");
const manualPoliciesPath = resolve(shopDir, "manual-policies.txt");
const bannerPath = resolve(shopDir, "banner.png");
const brandGuidePath = resolveProjectPath("data/brand/brand-guide.json");

/**
 * Normalizes smart punctuation into ASCII-friendly characters so stored shop copy stays readable across shells and exports.
 */
function normalizeAsciiText(value: string): string {
  return value
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ");
}

/**
 * Applies ASCII-friendly normalization to all generated shop-copy fields before saving or sending them.
 */
function normalizeShopText(value: string): string {
  return value
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ");
}

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
 * Applies ASCII-friendly normalization to all generated shop-copy fields before saving or sending them.
 */
function normalizeShopCopy(copy: ShopCopyPayload): ShopCopyPayload {
  return {
    ...copy,
    title: normalizeShopText(copy.title),
    announcement: normalizeShopText(copy.announcement),
    sale_message: normalizeShopText(copy.sale_message),
    policy_welcome: normalizeShopText(copy.policy_welcome),
    policy_payment: normalizeShopText(copy.policy_payment),
    policy_shipping: normalizeShopText(copy.policy_shipping),
    policy_refunds: normalizeShopText(copy.policy_refunds),
    policy_additional: normalizeShopText(copy.policy_additional),
    sections: copy.sections.map((section) => normalizeShopText(section)),
    about_story: normalizeShopText(copy.about_story),
    about_headline: normalizeShopText(copy.about_headline),
    faq: copy.faq.map((item) => ({
      question: normalizeShopText(item.question),
      answer: normalizeShopText(item.answer),
    })),
  };
}

/**
 * Loads niche seeds from disk so first-run shop copy can use the intended catalog direction even before analytics exist.
 */
async function loadActiveNicheNames(): Promise<string[]> {
  const niches = JSON.parse(await readFile(resolveProjectPath("data/niches.json"), "utf8")) as Array<{ name: string }>;
  return niches.map((niche) => niche.name).slice(0, 6);
}

/**
 * Loads the approved Feint brand guide so storefront copy and visuals stay aligned.
 */
async function loadBrandGuide(): Promise<{
  store_name: string;
  tagline: string;
  brand_voice: string;
  visual_style: string;
}> {
  return JSON.parse(await readFile(brandGuidePath, "utf8")) as {
    store_name: string;
    tagline: string;
    brand_voice: string;
    visual_style: string;
  };
}

/**
 * Reads the top-performing themes from analytics data and falls back to niches when there is not enough sales history yet.
 */
function loadTopThemesFromDb(fallbackNiches: string[]): string[] {
  initializeDatabase();
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      COALESCE(json_extract(l.metadata, '$.keyword'), d.theme, l.title) AS theme,
      COALESCE(SUM(a.revenue), 0) AS revenue
    FROM listings l
    LEFT JOIN designs d ON d.id = l.design_id
    LEFT JOIN analytics a ON a.listing_id = l.id
    GROUP BY theme
    ORDER BY revenue DESC, theme ASC
    LIMIT 3
  `).all() as Array<{ theme: string | null }>;

  const themes = rows.map((row) => row.theme ?? "").filter((theme) => theme.trim().length > 0);
  const alignmentTerms = [
    "veteran",
    "cyber",
    "law enforcement",
    "quiet professional",
    "operator",
    "soc",
    "osint",
    "hacker",
    "signal",
    "comms",
    "intelligence",
    "dark",
    "minimal",
    "tech",
    "service",
  ];
  const alignedThemes = themes.filter((theme) => {
    const lowered = theme.toLowerCase();
    return alignmentTerms.some((term) => lowered.includes(term));
  });

  return (alignedThemes.length > 0 ? alignedThemes : fallbackNiches).slice(0, 3);
}

/**
 * Builds the prompt context that Claude uses to draft a coherent Etsy storefront voice.
 */
async function buildShopContext(): Promise<ShopContext> {
  const brandGuide = await loadBrandGuide();
  const primaryNiches = await loadActiveNicheNames();
  const shopName = (process.env.STORE_BRAND_NAME ?? brandGuide.store_name ?? "Feint Supply Co.").trim();
  return {
    shop_name: shopName,
    tagline: (process.env.STORE_TAGLINE ?? brandGuide.tagline ?? "Built different. By people who were.").trim(),
    primary_niches: primaryNiches,
    top_themes: loadTopThemesFromDb(primaryNiches),
    product_types: ["t-shirts", "hoodies", "posters", "stickers", "mugs", "enamel pins"],
    style: (process.env.STORE_BRAND_THEME ?? `${brandGuide.brand_voice} ${brandGuide.visual_style}`).trim(),
  };
}

/**
 * Uses Claude to generate the complete shop copy payload in one structured response.
 */
async function generateShopCopy(context: ShopContext): Promise<ShopCopyPayload> {
  const prompt = `You are setting up an Etsy store called ${context.shop_name} that sells made-to-order products including t-shirts, hoodies, posters, stickers, mugs, and enamel pins. The store tagline is "${context.tagline}". The store focuses on these niches: ${context.primary_niches.join(", ")}.

Generate complete Etsy store copy in JSON format only, no preamble.
Requirements per field:

title: 55 chars max, keyword-rich, evokes quiet authority, precision, and modern credibility.

announcement: 200 chars max, welcoming, mentions free shipping threshold if relevant, mentions new arrivals, no ALL CAPS.

sale_message: Sent after purchase. Warm, professional, includes expected production time (3-5 business days via print-on-demand), encourages review, thanks buyer. 150 chars max.

policy_welcome: 2-3 sentences. Friendly intro to the shop, what makes it special, commitment to quality. Must fit a veteran-and-tech-forward audience.

policy_payment: 2-3 sentences. Etsy payments accepted, secure checkout, no payment plans.

policy_shipping: 3-4 sentences. Print-on-demand production time 3-5 days, US shipping 5-10 days total, international available, tracking provided.

policy_refunds: 3-4 sentences. Satisfaction guaranteed on damaged or defective items, contact within 14 days, exchanges available, digital items non-refundable.

policy_additional: 2-3 sentences. AI-assisted design disclosure, custom orders welcome via message, bulk discounts available.

sections: Array of 4-6 shop section names that organize the product catalog.

about_story: 3-4 paragraphs. The shop's story - service-informed perspective, what inspires the designs, cybersecurity and quiet professional ethos, commitment to quality print-on-demand. Warm, personal, authentic-sounding. Do NOT claim to be a human-run small business. Use language like "our collection", "we believe", "each design".

about_headline: 10 words max. Punchy headline for the about section.

faq: Array of 6 objects. Common buyer questions:
- How long does shipping take?
- Can I customize a design?
- What if my item arrives damaged?
- Do you ship internationally?
- What sizes are available?
- Are these designs AI-generated?
Each answer: 2-3 sentences, friendly and direct.

Shop context:
${JSON.stringify(context, null, 2)}

Return ONLY valid JSON, no markdown backticks, no preamble.`;

  const response = await callLLM({
    taskType: "listing_copywriting",
    prompt,
    maxTokens: 1800,
    temperature: 0.5,
    expectJson: true,
  });

  const text = stripMarkdownFences(response.text ?? "");
  return normalizeShopCopy(JSON.parse(text) as ShopCopyPayload);
}

/**
 * Generates a monthly announcement refresh that references the season and current best-performing themes.
 */
export async function refreshShopAnnouncement(): Promise<string> {
  const context = await buildShopContext();
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date());
  const topThemes = context.top_themes.join(", ");
  const saleMessage = "Production time is 3-5 business days via print-on-demand.";
  const prompt = `Write one Etsy shop announcement under 200 characters for ${month}. Consider these current best-performing themes: ${topThemes}. Current sale message context: ${saleMessage}. Keep it warm, seasonal, and marketplace-ready. Return plain text only.`;
  const response = await callLLM({
    taskType: "listing_copywriting",
    prompt,
    maxTokens: 120,
    temperature: 0.6,
  });
  return normalizeAsciiText(response.text?.trim() ?? "");
}

/**
 * Renders FAQ pairs into a readable plain-text appendix for manual reference outside the Etsy API.
 */
function renderFaqText(faq: ShopCopyPayload["faq"]): string {
  return faq.map((item, index) => `${index + 1}. ${item.question}\n${item.answer}`).join("\n\n");
}

/**
 * Builds the policy_additional text that Etsy can store natively while preserving a readable FAQ appendix.
 */
function buildPolicyAdditionalWithFaq(copy: ShopCopyPayload): string {
  const faqBlock = copy.faq.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n");
  return `${copy.policy_additional.trim()}\n\nFAQ\n${faqBlock}`.slice(0, 4000);
}

/**
 * Writes a manual-entry policy file when Etsy rejects policy updates through the API.
 */
async function writeManualPoliciesFile(copy: ShopCopyPayload): Promise<void> {
  const content = [
    "═══════════════════════════════════════",
    "FEINT SUPPLY CO. — MANUAL POLICY ENTRY",
    "═══════════════════════════════════════",
    "Enter these manually at:",
    "etsy.com/your/shops/feintsupplyco/policy",
    "",
    "WELCOME MESSAGE:",
    copy.policy_welcome,
    "",
    "PAYMENT:",
    copy.policy_payment,
    "",
    "SHIPPING:",
    copy.policy_shipping,
    "",
    "RETURNS & EXCHANGES:",
    copy.policy_refunds,
    "",
    "ADDITIONAL INFO:",
    copy.policy_additional,
    "═══════════════════════════════════════",
  ].join("\n");

  await writeFile(manualPoliciesPath, `${content}\n`, "utf8");
}

/**
 * Saves generated shop copy and any manual-entry fallbacks into the local data/shop directory.
 */
async function saveShopArtifacts(copy: ShopCopyPayload, setupLog: ShopSetupLog): Promise<void> {
  await mkdir(shopDir, { recursive: true });
  await writeFile(shopConfigPath, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    copy,
  }, null, 2)}\n`, "utf8");
  await writeFile(aboutStoryPath, `${copy.about_headline}\n\n${copy.about_story}\n`, "utf8");
  await writeFile(faqPath, `${renderFaqText(copy.faq)}\n`, "utf8");
  await writeFile(setupLogPath, `${JSON.stringify(setupLog, null, 2)}\n`, "utf8");
}

/**
 * Generates a wide banner asset for the storefront and saves it locally whether or not Etsy supports direct upload.
 */
async function generateShopBanner(shopTitle: string, dryRun: boolean): Promise<string> {
  await mkdir(shopDir, { recursive: true });
  const brandBannerPath = resolveProjectPath("data/brand/shop-banner.png");

  try {
    await stat(brandBannerPath);
    await copyFile(brandBannerPath, bannerPath);
    return bannerPath;
  } catch {
    logger.warn("Brand banner not found; skipping shop banner generation.", {
      shopTitle,
      dryRun,
      brandBannerPath,
    });
    return "";
  }
}

/**
 * Creates any missing Etsy shop sections and mirrors the resulting IDs into the local SQLite registry.
 */
async function ensureShopSections(sectionTitles: string[], dryRun: boolean): Promise<Array<{ title: string; etsy_section_id?: string }>> {
  const normalizedTitles = [...new Set([...sectionTitles, "Stickers"])];
  if (dryRun) {
    return normalizedTitles.map((title, index) => ({ title, etsy_section_id: `preview-${index + 1}` }));
  }

  const existingSections = await listShopSections();
  const result: Array<{ title: string; etsy_section_id?: string }> = [];
  const createdTitles: string[] = [];
  const skippedTitles: string[] = [];

  for (const title of normalizedTitles) {
    const existing = existingSections.find((section) => section.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      upsertShopSection(existing.shop_section_id, existing.title);
      result.push({ title: existing.title, etsy_section_id: String(existing.shop_section_id) });
      createdTitles.push(existing.title);
      continue;
    }

    try {
      const created = await createShopSection(title);
      upsertShopSection(created.shop_section_id, created.title);
      result.push({ title: created.title, etsy_section_id: String(created.shop_section_id) });
      createdTitles.push(created.title);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skippedTitles.push(title);
      logger.warn("Shop section creation failed; skipping section.", {
        sectionTitle: title,
        error: message,
      });
    }
  }

  console.log(`SHOP SECTIONS CREATED: ${createdTitles.length > 0 ? createdTitles.join(", ") : "none"}`);
  console.log(`SHOP SECTIONS SKIPPED: ${skippedTitles.length > 0 ? skippedTitles.join(", ") : "none"}`);

  return result;
}

/**
 * Applies generated shop copy to Etsy using supported shop-management endpoints and records any manual fallbacks.
 */
async function applyShopConfiguration(copy: ShopCopyPayload, setupLog: ShopSetupLog): Promise<void> {
  const shopUpdateResult = await updateShopCore({
    title: copy.title,
    announcement: copy.announcement,
    saleMessage: copy.sale_message,
    policyWelcome: copy.policy_welcome,
    policyPayment: copy.policy_payment,
    policyShipping: copy.policy_shipping,
    policyRefunds: copy.policy_refunds,
    policyAdditional: buildPolicyAdditionalWithFaq(copy),
  });

  if (shopUpdateResult.policiesManualRequired) {
    await writeManualPoliciesFile(copy);
    setupLog.manual_actions.push("Policies require manual entry. See data/shop/manual-policies.txt.");
    if (shopUpdateResult.policyErrorMessage) {
      setupLog.manual_actions.push(shopUpdateResult.policyErrorMessage);
    }
  }

  setupLog.sections = await ensureShopSections(copy.sections, false);

  try {
    await updateShopAboutStory(copy.about_story);
  } catch (error) {
    setupLog.manual_actions.push("About section requires manual entry via Etsy dashboard. Story saved locally.");
    logger.warn("Shop about endpoint was unavailable; keeping manual fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  setupLog.manual_actions.push("Banner upload may require manual Etsy dashboard confirmation. Banner saved locally.");

  console.log("APPLIED VIA API: title, announcement, sale_message, sections");
  if (shopUpdateResult.policiesManualRequired) {
    console.log("MANUAL REQUIRED: policies (see data/shop/manual-policies.txt)");
  } else {
    console.log("MANUAL REQUIRED: none for policies");
  }
  console.log("                 banner, icon (see data/brand/manual-uploads.txt)");
}

/**
 * Runs the full shop setup flow or the monthly announcement refresh path.
 */
export async function runShopSetup(options: ShopSetupOptions = {}): Promise<{ shopContext: ShopContext; copy?: ShopCopyPayload; refreshAnnouncement?: string; shopDirectory: string }> {
  const dryRun = options.dryRun === true;
  const refreshOnly = options.refreshOnly === true;
  const shopContext = await buildShopContext();

  let setupLog: ShopSetupLog = {
    setup_complete: false,
    last_run_at: new Date().toISOString(),
    manual_actions: [],
    sections: [],
  };

  try {
    const existingLog = JSON.parse(await readFile(setupLogPath, "utf8")) as ShopSetupLog;
    setupLog = {
      ...existingLog,
      last_run_at: new Date().toISOString(),
      manual_actions: existingLog.manual_actions ?? [],
      sections: existingLog.sections ?? [],
    };
  } catch {
    setupLog = {
      setup_complete: false,
      last_run_at: new Date().toISOString(),
      manual_actions: [],
      sections: [],
    };
  }

  if (refreshOnly) {
    const announcement = await refreshShopAnnouncement();
    setupLog.last_refresh_at = new Date().toISOString();
    if (!dryRun) {
      await updateShopCore({ announcement });
    }
    await mkdir(shopDir, { recursive: true });
    await writeFile(setupLogPath, `${JSON.stringify(setupLog, null, 2)}\n`, "utf8");
    return {
      shopContext,
      refreshAnnouncement: announcement,
      shopDirectory: shopDir,
    };
  }

  const copy = await generateShopCopy(shopContext);
  const bannerFile = await generateShopBanner(copy.title, dryRun);
  setupLog.manual_actions = setupLog.manual_actions.filter((action) => !action.includes("Banner upload"));
  if (!dryRun) {
    await applyShopConfiguration(copy, setupLog);
    setupLog.setup_complete = true;
  } else {
    setupLog.sections = await ensureShopSections(copy.sections, true);
    setupLog.manual_actions.push("Preview mode: no Etsy API calls were made.");
  }

  await saveShopArtifacts(copy, setupLog);
  logger.action("Shop setup artifacts generated", "success", {
    dryRun,
    refreshOnly,
    shopDir,
    bannerFile,
  });

  return {
    shopContext,
    copy,
    shopDirectory: shopDir,
  };
}

/**
 * Parses CLI flags for preview and refresh-only modes.
 */
function parseCliArgs(argv: string[]): ShopSetupOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    refreshOnly: argv.includes("--refresh-only"),
  };
}

/**
 * Detects direct execution so the shop setup script can run standalone from npm scripts.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone shop setup entry point and prints a compact machine-readable summary.
 */
async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await runShopSetup(options);
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution()) {
  await main();
}
