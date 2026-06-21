import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";

import { resolveProjectPath } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { runClaudeCompletion } from "../lib/claude-client.js";

interface ShopFaqItem {
  question: string;
  answer: string;
}

interface BrandBios {
  short: string;
  about_section: string;
  dark_humor: string;
  professional: string;
  mission_statement: string;
  listing_footer: string;
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
  about_headline: string;
  about_story: string;
  faq: ShopFaqItem[];
  brand_bios: BrandBios;
}

const logger = createLogger("regenerate-feint-shop-copy");
const shopDir = resolveProjectPath("data/shop");
const shopConfigPath = resolveProjectPath("data/shop/shop-config.json");
const aboutStoryPath = resolveProjectPath("data/shop/about-story.txt");
const faqPath = resolveProjectPath("data/shop/faq.txt");
const brandBiosPath = resolveProjectPath("data/shop/brand-bios.txt");

const prompt = `You are writing Etsy store copy for Feint Supply Co.

FOUNDER BACKGROUND (use to inform voice and authenticity):
Brendan Dodd is a U.S. Army Infantry veteran, former law 
enforcement detective, private investigator, and SOC analyst 
in cybersecurity. His career has involved criminal investigations, 
digital evidence, fraud, threat detection, incident response, 
and high-pressure operational environments. He founded Feint 
Supply Co. to turn that background into practical, gritty, 
intelligence-inspired goods for people who live and work in 
the same world he came from.

The name Feint comes from military and investigative strategy: 
a deliberate maneuver that redirects attention and creates 
advantage. Signal over noise. Deliberate movement. Quiet 
competence.

BRAND VOICE RULES:
- Grounded. Sounds like it came from real experience.
- Dry and authoritative. Short sentences. No filler.
- Dark humor is allowed and encouraged - used as survival 
  gear, not edgelord noise.
- Confident without bragging. Capable without performing.
- Accessible to veterans, analysts, investigators, gamers,
  cybersecurity professionals, and civilians who appreciate grit.
- NEVER: fake motivational fluff, performative military 
  toughness, excessive operator jargon, trauma-dumping,
  political messaging, generic Etsy warmth, Punisher skulls,
  or anything that sounds like a surplus store.
- NEVER use: "perfect gift", "great for anyone", "small but 
  mighty", "passion project", or any cliche Etsy-seller phrasing.
- NEVER imply active law enforcement authority or government 
  endorsement.
- DO NOT reference sensitive case types from his LE background.

WORDS THAT FIT:
Signal, noise, field, perimeter, case, evidence, log, trace,
alert, resilience, archive, intel, breach, burnout, static,
after-action, debrief, prepared, quiet, sharp, practical,
pattern, shadow, grid, dispatch, recon, control, systems

BUSINESS CONSTRAINTS (use exactly as written):
- Print-on-demand via Printify. Items are made to order.
- Production: 2-5 business days
- US delivery total: 5-12 business days
- International: 10-21 business days
- Returns: not accepted on non-defective made-to-order items
- Defective or damaged: replacement or refund within 14 days
  with photo evidence of defect
- Payment: Etsy Payments only
- Designs are AI-assisted (must be disclosed per Etsy policy)
- Custom orders: not offered at this time

Generate the following JSON object exactly as structured.
All text must be ASCII-safe: straight quotes, hyphens only,
no curly quotes, em dashes, or special characters.

{
  "title": "Feint Supply Co. -- Veteran-Owned Tees, Prints & Gear",

  "announcement": "Write 1-2 sentences. Under 200 characters.
    No exclamation marks. No warmth performance.
    Grounded. Mention made-to-order quality or the community
    this shop is built for. Example tone: measured, direct,
    slightly dry. End with something that respects the buyer.",

  "sale_message": "Under 160 characters. Sent after purchase.
    Confirm the order. Give the timeline honestly (5-12 days US).
    One line of dry appreciation -- not effusive, not cold.
    No emojis.",

  "policy_welcome": "2-3 sentences. What this shop is and who
    built it. Veteran and former LE owned. AI-assisted designs
    directed and curated by someone with real operational
    background. Made to order. Honest, direct, no fluff.",

  "policy_payment": "2 sentences. Etsy Payments accepted.
    All major cards, PayPal, Apple Pay, Google Pay through
    Etsy checkout. Payment processed at time of order.
    No payment plans.",

  "policy_shipping": "4-5 sentences. Made to order -- production
    2-5 business days. US delivery 5-12 business days total.
    International 10-21 business days. Tracking on all orders.
    Acknowledge that delays happen during peak periods.
    Do not overpromise.",

  "policy_refunds": "4-5 sentences. Made-to-order means returns
    are not accepted on non-defective items -- be clear and
    direct about this without being cold. If an item arrives
    damaged or defective: contact within 14 days with a photo
    and it will be replaced or refunded. Check size guides
    before ordering. State clearly that product quality is
    backed by the shop.",

  "policy_additional": "3 sentences. Disclose AI-assisted
    design as required by Etsy policy -- frame this honestly
    using the founder's context: designs are AI-assisted,
    human-directed by someone who has lived the culture these
    designs represent. No custom orders at this time.
    Questions go to the shop message system.",

  "sections": [
    "SOC and Cyber Culture",
    "Veteran Mindset",
    "Investigator Aesthetic",
    "Dark Humor Gear",
    "Field Notes",
    "Signal and Noise"
  ],

  "about_headline": "8 words max. Sharp. Earned. No fluff.
    Should feel like a case file header or a mission brief --
    not a bumper sticker. Use brand vocabulary.",

  "about_story": "Write 3 paragraphs using the Option 3 Etsy-
    friendly tone as the primary model -- human, founder-focused,
    grounded. Reference Brendan by first name. Mention Army,
    detective, PI, and SOC analyst background naturally without
    listing them like a resume. Explain what Feint means briefly.
    Close with something dry and real. No fake warmth. No
    motivational poster energy. Sound like someone who has
    actually done the work and is being straight with you
    about what this shop is and who it is for.",

  "faq": [
    {
      "question": "How long does shipping take?",
      "answer": "Accurate: 2-5 days production plus 3-7 days
        US shipping equals 5-12 days total. International
        10-21 days. Tracking provided. Dry, honest tone."
    },
    {
      "question": "What if my item arrives damaged or wrong?",
      "answer": "Contact within 14 days with a photo of the
        issue. Replacement or refund -- no bureaucratic
        runaround. Direct and reassuring without being warm
        and fuzzy about it."
    },
    {
      "question": "Can I return or exchange my order?",
      "answer": "Items are made to order -- returns on
        non-defective items are not accepted. Check the size
        guide before ordering. Defective items are always
        covered. Honest and clear."
    },
    {
      "question": "Are the designs AI-generated?",
      "answer": "Be honest about AI-assisted process.
        Acknowledge that every design is directed and
        selected by a human who has actually lived in
        the world these designs reference. Do not be
        defensive or evasive about it."
    },
    {
      "question": "What sizes are available?",
      "answer": "Check the size guide on each listing.
        When in doubt, size up for print-on-demand apparel.
        Short and practical."
    },
    {
      "question": "Is this a veteran or first responder owned shop?",
      "answer": "Yes. Army veteran, former detective, PI, and
        SOC analyst. Not a marketing angle -- just who built
        this. Dry, grounded, no performance."
    }
  ],

  "brand_bios": {
    "short": "1-2 sentences. Clean, credible, slightly gritty.
      Mentions veteran and LE background. Accessible.",
    "about_section": "Use Option 2 gritty and brand-forward
      tone from the brief. 3 paragraphs. Human, direct,
      brand-centered.",
    "dark_humor": "2-3 paragraphs. Use Option 4 dark humor
      tone. Funny, sharp, not offensive. References the chaos
      of his career without specifics. Ends with something
      that lands.",
    "professional": "1 paragraph. Resume-adjacent but still
      brand-friendly. Mentions all four background areas.",
    "mission_statement": "1-2 paragraphs. Strong and clear.
      Product-focused. Explain what Feint Supply Co. is for
      and who it serves. Use brand vocabulary.",
    "listing_footer": "2-4 sentences. Reusable brand footer
      for product listings. Short. Reinforces brand identity.
      Could mention veteran ownership, made-to-order quality,
      or a dry brand line."
  }
}

Fill every field with real copy. No placeholder text.
Return ONLY the completed JSON.`;

/**
 * Normalizes smart punctuation and non-ASCII spaces so stored copy stays ASCII-safe.
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
 * Strips optional Markdown fences so JSON parsing can recover from model formatting noise.
 */
function stripCodeFences(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Recursively normalizes all string leaves in the generated payload.
 */
function deepNormalize<T>(value: T): T {
  if (typeof value === "string") {
    return normalizeAsciiText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepNormalize(item)) as T;
  }
  if (value && typeof value === "object") {
    const normalizedEntries = Object.entries(value).map(([key, nestedValue]) => [key, deepNormalize(nestedValue)]);
    return Object.fromEntries(normalizedEntries) as T;
  }
  return value;
}

/**
 * Ensures all required copy fields are populated before files are overwritten.
 */
function validateShopCopyPayload(payload: ShopCopyPayload): void {
  const requiredStringFields: Array<keyof ShopCopyPayload> = [
    "title",
    "announcement",
    "sale_message",
    "policy_welcome",
    "policy_payment",
    "policy_shipping",
    "policy_refunds",
    "policy_additional",
    "about_headline",
    "about_story",
  ];

  for (const field of requiredStringFields) {
    if (!payload[field] || typeof payload[field] !== "string" || (payload[field] as string).trim().length === 0) {
      throw new Error(`Generated shop copy is missing required field: ${String(field)}.`);
    }
  }

  if (payload.sections.length === 0 || payload.sections.some((section) => section.trim().length === 0)) {
    throw new Error("Generated shop copy is missing one or more section names.");
  }

  if (payload.faq.length !== 6 || payload.faq.some((item) => item.question.trim().length === 0 || item.answer.trim().length === 0)) {
    throw new Error("Generated shop copy did not return six fully populated FAQ items.");
  }

  const brandBioEntries = Object.entries(payload.brand_bios) as Array<[keyof BrandBios, string]>;
  for (const [key, value] of brandBioEntries) {
    if (!value || value.trim().length === 0) {
      throw new Error(`Generated shop copy is missing brand_bios.${key}.`);
    }
  }
}

/**
 * Calls Claude with the approved Feint prompt and retries once if the response is not valid JSON.
 */
async function generateShopCopyWithRetry(): Promise<ShopCopyPayload> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runClaudeCompletion(prompt, {
        model: "claude-sonnet-4-6",
        maxTokens: 2600,
        temperature: 0.55,
        expectJson: true,
      });
      const parsed = JSON.parse(stripCodeFences(result.text)) as ShopCopyPayload;
      const normalized = deepNormalize(parsed);
      validateShopCopyPayload(normalized);
      return normalized;
    } catch (error) {
      lastError = error;
      logger.warn("Failed to parse or validate Claude shop copy; retrying once", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Formats FAQ content into a readable text file for manual review or reuse.
 */
function renderFaqText(faq: ShopFaqItem[]): string {
  return faq.map((item, index) => `${index + 1}. ${item.question}\n${item.answer}`).join("\n\n");
}

/**
 * Formats all brand bio variants into a readable text file for manual copy-paste.
 */
function renderBrandBiosText(brandBios: BrandBios): string {
  return [
    "SHORT",
    brandBios.short,
    "",
    "ABOUT_SECTION",
    brandBios.about_section,
    "",
    "DARK_HUMOR",
    brandBios.dark_humor,
    "",
    "PROFESSIONAL",
    brandBios.professional,
    "",
    "MISSION_STATEMENT",
    brandBios.mission_statement,
    "",
    "LISTING_FOOTER",
    brandBios.listing_footer,
  ].join("\n");
}

/**
 * Prints the requested review fields to stdout for immediate operator review.
 */
function printReview(payload: ShopCopyPayload): void {
  console.log(`TITLE\n${payload.title}\n`);
  console.log(`ANNOUNCEMENT\n${payload.announcement}\n`);
  console.log(`ABOUT_HEADLINE\n${payload.about_headline}\n`);
  console.log(`ABOUT_STORY\n${payload.about_story}\n`);
  console.log("FAQ ANSWERS");
  for (const item of payload.faq) {
    console.log(`- ${item.question}\n${item.answer}\n`);
  }
  console.log(`BRAND_BIOS.SHORT\n${payload.brand_bios.short}\n`);
  console.log(`BRAND_BIOS.DARK_HUMOR\n${payload.brand_bios.dark_humor}\n`);
  console.log(`BRAND_BIOS.LISTING_FOOTER\n${payload.brand_bios.listing_footer}\n`);
}

/**
 * Generates the approved Feint shop copy package and writes the review artifacts to disk.
 */
async function main(): Promise<void> {
  await mkdir(shopDir, { recursive: true });
  const payload = await generateShopCopyWithRetry();

  await writeFile(shopConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(aboutStoryPath, `${payload.about_headline}\n\n${payload.about_story}\n`, "utf8");
  await writeFile(faqPath, `${renderFaqText(payload.faq)}\n`, "utf8");
  await writeFile(brandBiosPath, `${renderBrandBiosText(payload.brand_bios)}\n`, "utf8");

  logger.action("Feint shop copy regenerated", "success", {
    shopConfigPath,
    aboutStoryPath,
    faqPath,
    brandBiosPath,
  });
  printReview(payload);
}

await main();
