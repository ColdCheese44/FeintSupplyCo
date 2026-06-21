import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import sharp from "sharp";

import { resolveProjectPath } from "./db.js";

export interface BrandGuide {
  store_name: string;
  tagline: string;
  alt_taglines: string[];
  brand_voice: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  background_color: string;
  text_color: string;
  font_primary: string;
  font_secondary: string;
  visual_style: string;
  logo_prompt: string;
  banner_prompt: string;
  icon_prompt: string;
  pinterest_template_prompt: string;
  social_header_prompt: string;
  email_header_prompt: string;
  watermark_prompt: string;
  design_style_instruction: string;
}

export interface BrandAssetRecord {
  filename: string;
  outputPath: string;
  width: number;
  height: number;
}

export interface StickerDesignRecord {
  id: number;
  name: string;
  outputPath: string;
  width: number;
  height: number;
}

export interface TshirtDesignRecord {
  id: number;
  name: string;
  outputPath: string;
  width: number;
  height: number;
}

interface ProgrammaticProductDesignRecord {
  id: number;
  name: string;
  outputPath: string;
  width: number;
  height: number;
}

export interface MugDesignRecord extends ProgrammaticProductDesignRecord {}

export interface PosterDesignRecord extends ProgrammaticProductDesignRecord {}

export interface HoodieDesignRecord extends ProgrammaticProductDesignRecord {}

const STORE_NAME = "FEINT SUPPLY CO.";
const TAGLINE = "Signal over noise.";
const COLOR_BG = "#0D1117";
const COLOR_BG_ALT = "#1A1F2E";
const COLOR_CYAN = "#00D4FF";
const COLOR_AMBER = "#F5A623";
const COLOR_TEXT = "#E8E8E8";
const FONT_PRIMARY = "Space Grotesk, Arial, sans-serif";
const FONT_MONO = "JetBrains Mono, Courier New, monospace";

/**
 * Escapes text content for safe insertion into inline SVG strings.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Loads the persisted brand guide so deterministic assets still depend on the approved brand document.
 */
export async function loadBrandGuide(): Promise<BrandGuide> {
  return JSON.parse(await readFile(resolveProjectPath("data/brand/brand-guide.json"), "utf8")) as BrandGuide;
}

/**
 * Makes sure the brand output directory exists before any SVG or PNG assets are written.
 */
async function ensureBrandDirectory(): Promise<void> {
  await mkdir(resolveProjectPath("data/brand"), { recursive: true });
}

/**
 * Makes sure the sticker output directory exists before deterministic sticker assets are written.
 */
async function ensureStickerDirectory(stickerId: number): Promise<string> {
  const directoryPath = resolveProjectPath(`data/stickers/${stickerId}`);
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

/**
 * Saves the SVG source alongside the rendered PNG so visual debugging stays straightforward.
 */
async function writeSvgSource(filename: string, svg: string): Promise<void> {
  await writeFile(resolveProjectPath(`data/brand/${filename}`), `${svg}\n`, "utf8");
}

/**
 * Renders an SVG string to PNG via sharp with deterministic dimensions.
 */
async function renderSvgToPng(svg: string, outputPath: string, width: number, height: number): Promise<void> {
  await sharp(Buffer.from(svg))
    .resize(width, height)
    .png()
    .toFile(outputPath);
}

/**
 * Ensures a deterministic product-design directory exists before SVG and PNG exports are written.
 */
async function ensureProductDesignDirectory(productDirectory: string, designId: number): Promise<string> {
  const directoryPath = resolveProjectPath(`data/${productDirectory}/${designId}`);
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

/**
 * Writes one deterministic product design from its manifest entry and SVG builder.
 */
async function writeProgrammaticProductDesign<T extends ProgrammaticProductDesignRecord>(
  productDirectory: string,
  manifest: T[],
  designId: number,
  buildSvg: (resolvedDesignId: number) => string,
): Promise<T> {
  const manifestEntry = manifest.find((entry) => entry.id === designId);
  if (!manifestEntry) {
    throw new Error(`No ${productDirectory} design manifest entry exists for design ${designId}.`);
  }

  await ensureProductDesignDirectory(productDirectory, designId);
  const svg = buildSvg(designId);
  await writeFile(resolveProjectPath(`data/${productDirectory}/${designId}/design.svg`), `${svg}\n`, "utf8");
  await renderSvgToPng(svg, manifestEntry.outputPath, manifestEntry.width, manifestEntry.height);
  return manifestEntry;
}

/**
 * Builds the subtle grid pattern used on dark surfaces.
 */
function buildGridPattern(patternId: string, spacing: number, strokeColor: string, strokeWidth: number): string {
  return `
    <defs>
      <pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${spacing}" height="${spacing}">
        <path d="M 0 ${spacing} L ${spacing} ${spacing}" stroke="${strokeColor}" stroke-width="${strokeWidth}" fill="none" />
        <path d="M ${spacing} 0 L ${spacing} ${spacing}" stroke="${strokeColor}" stroke-width="${strokeWidth}" fill="none" />
      </pattern>
    </defs>
  `;
}

/**
 * Primary transparent logo.
 */
function buildPrimaryLogoSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <g fill="none" stroke="${COLOR_AMBER}" stroke-width="2.5" stroke-linecap="round">
      <path d="M 494 400 L 512 409" />
      <path d="M 494 418 L 512 409" />
    </g>
    <line x1="156" y1="434" x2="868" y2="434" stroke="${COLOR_CYAN}" stroke-width="1.5" />
    <text x="512" y="514" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="68" font-weight="700" letter-spacing="10">${escapeXml(STORE_NAME)}</text>
    <line x1="156" y1="552" x2="868" y2="552" stroke="${COLOR_CYAN}" stroke-width="1.5" />
  </svg>
  `.trim();
}

/**
 * Dark logo variant with subtle grid texture.
 */
function buildDarkLogoSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    ${buildGridPattern("grid", 40, COLOR_BG_ALT, 0.5)}
    <rect width="1024" height="1024" fill="${COLOR_BG}" />
    <rect width="1024" height="1024" fill="url(#grid)" />
    <g fill="none" stroke="${COLOR_AMBER}" stroke-width="2.5" stroke-linecap="round">
      <path d="M 494 400 L 512 409" />
      <path d="M 494 418 L 512 409" />
    </g>
    <line x1="156" y1="434" x2="868" y2="434" stroke="${COLOR_CYAN}" stroke-width="1.5" />
    <text x="512" y="514" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="68" font-weight="700" letter-spacing="10">${escapeXml(STORE_NAME)}</text>
    <line x1="156" y1="552" x2="868" y2="552" stroke="${COLOR_CYAN}" stroke-width="1.5" />
  </svg>
  `.trim();
}

/**
 * Light logo variant for docs and light-surface exports.
 */
function buildLightLogoSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="${COLOR_TEXT}" />
    <g fill="none" stroke="${COLOR_AMBER}" stroke-width="2.5" stroke-linecap="round">
      <path d="M 494 400 L 512 409" />
      <path d="M 494 418 L 512 409" />
    </g>
    <line x1="156" y1="434" x2="868" y2="434" stroke="${COLOR_BG}" stroke-width="1.5" stroke-opacity="0.4" />
    <text x="512" y="514" text-anchor="middle" fill="${COLOR_BG}" font-family="${FONT_PRIMARY}" font-size="68" font-weight="700" letter-spacing="10">${escapeXml(STORE_NAME)}</text>
    <line x1="156" y1="552" x2="868" y2="552" stroke="${COLOR_BG}" stroke-width="1.5" stroke-opacity="0.4" />
  </svg>
  `.trim();
}

/**
 * Etsy-safe profile icon and logo icon.
 */
function buildIconSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
    <circle cx="250" cy="250" r="238" fill="${COLOR_BG}" stroke="${COLOR_CYAN}" stroke-width="2" />
    <text x="250" y="290" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="118" font-weight="700" letter-spacing="8">FSC</text>
    <line x1="110" y1="312" x2="390" y2="312" stroke="${COLOR_CYAN}" stroke-width="1.5" />
    <circle cx="250" cy="330" r="3" fill="${COLOR_AMBER}" />
  </svg>
  `.trim();
}

/**
 * Banner base layer.
 */
function buildBannerBaseSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="3360" height="840" viewBox="0 0 3360 840">
    ${buildGridPattern("grid", 60, COLOR_BG_ALT, 0.5)}
    <rect width="3360" height="840" fill="${COLOR_BG}" />
    <rect width="3360" height="840" fill="url(#grid)" />
    <rect x="0" y="0" width="5" height="840" fill="${COLOR_CYAN}" />
    <line x1="0" y1="38" x2="3360" y2="38" stroke="${COLOR_CYAN}" stroke-width="0.8" stroke-opacity="0.25" />
    <line x1="0" y1="802" x2="3360" y2="802" stroke="${COLOR_CYAN}" stroke-width="0.8" stroke-opacity="0.25" />
  </svg>
  `.trim();
}

/**
 * Banner text and accent layer.
 */
function buildBannerTextSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="3360" height="840" viewBox="0 0 3360 840">
    <g fill="none" stroke="${COLOR_AMBER}" stroke-width="3" stroke-linecap="round">
      <path d="M 200 310 L 224 322" />
      <path d="M 200 334 L 224 322" />
    </g>
    <text x="200" y="375" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="88" font-weight="700" letter-spacing="14">${escapeXml(STORE_NAME)}</text>
    <line x1="200" y1="392" x2="1100" y2="392" stroke="${COLOR_CYAN}" stroke-width="1" stroke-opacity="0.5" />
    <text x="202" y="435" fill="${COLOR_CYAN}" font-family="Arial, Helvetica, sans-serif" font-style="italic" font-size="28">${escapeXml(TAGLINE)}</text>
    <text x="3140" y="790" text-anchor="end" fill="${COLOR_AMBER}" font-family="${FONT_MONO}" font-size="16">VETERAN OWNED</text>
  </svg>
  `.trim();
}

/**
 * Pinterest template.
 */
function buildPinterestTemplateSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500">
    ${buildGridPattern("grid", 40, COLOR_BG, 0.5)}
    <rect width="1000" height="1500" fill="${COLOR_BG_ALT}" />
    <rect width="1000" height="1500" fill="url(#grid)" />
    <rect x="0" y="0" width="1000" height="5" fill="${COLOR_CYAN}" />
    <rect x="0" y="1495" width="1000" height="5" fill="${COLOR_CYAN}" />
    <rect x="0" y="0" width="4" height="1500" fill="${COLOR_CYAN}" />
    <rect x="996" y="0" width="4" height="1500" fill="${COLOR_CYAN}" />
    <text x="500" y="65" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="30" font-weight="700" letter-spacing="6">${escapeXml(STORE_NAME)}</text>
    <line x1="100" y1="80" x2="900" y2="80" stroke="${COLOR_CYAN}" stroke-width="1" />
    <line x1="100" y1="1395" x2="900" y2="1395" stroke="${COLOR_CYAN}" stroke-width="1" />
    <text x="500" y="1450" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="20">feint supply co.</text>
  </svg>
  `.trim();
}

/**
 * Social header variant to preserve the broader brand package.
 */
function buildSocialHeaderSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
    ${buildGridPattern("grid", 50, COLOR_BG_ALT, 0.5)}
    <rect width="1500" height="500" fill="${COLOR_BG}" />
    <rect width="1500" height="500" fill="url(#grid)" />
    <rect x="0" y="0" width="4" height="500" fill="${COLOR_CYAN}" />
    <text x="90" y="215" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="56" font-weight="700" letter-spacing="10">${escapeXml(STORE_NAME)}</text>
    <line x1="90" y1="245" x2="840" y2="245" stroke="${COLOR_CYAN}" stroke-width="1" stroke-opacity="0.5" />
    <text x="92" y="285" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="22">${escapeXml(TAGLINE)}</text>
    <text x="1390" y="460" text-anchor="end" fill="${COLOR_AMBER}" font-family="${FONT_MONO}" font-size="14">VETERAN OWNED</text>
  </svg>
  `.trim();
}

/**
 * Email header asset.
 */
function buildEmailHeaderSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
    <rect width="600" height="200" fill="${COLOR_BG}" />
    <rect x="0" y="0" width="4" height="200" fill="${COLOR_CYAN}" />
    <line x1="0" y1="35" x2="600" y2="35" stroke="${COLOR_CYAN}" stroke-width="0.8" stroke-opacity="0.2" />
    <line x1="0" y1="165" x2="600" y2="165" stroke="${COLOR_CYAN}" stroke-width="0.8" stroke-opacity="0.2" />
    <text x="30" y="108" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="38" font-weight="700" letter-spacing="8">${escapeXml(STORE_NAME)}</text>
    <text x="32" y="138" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="14">${escapeXml(TAGLINE)}</text>
  </svg>
  `.trim();
}

/**
 * Watermark asset.
 */
function buildWatermarkSvg(): string {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100">
    <text x="200" y="62" text-anchor="middle" fill="#FFFFFF" fill-opacity="0.25" font-family="${FONT_PRIMARY}" font-size="26" font-weight="700" letter-spacing="4">${escapeXml(STORE_NAME)}</text>
  </svg>
  `.trim();
}

/**
 * Composites the banner from separate background and text layers.
 */
async function renderBanner(outputPath: string): Promise<void> {
  const base = await sharp(Buffer.from(buildBannerBaseSvg())).png().toBuffer();
  const overlay = await sharp(Buffer.from(buildBannerTextSvg())).png().toBuffer();
  await sharp(base).composite([{ input: overlay }]).png().toFile(outputPath);
}

/**
 * Returns the stable sticker manifest used by the branded collection workflow.
 */
export function getStickerDesignManifest(): StickerDesignRecord[] {
  return [
    { id: 1, name: "Wordmark", outputPath: resolveProjectPath("data/stickers/1/design.png"), width: 1000, height: 1000 },
    { id: 2, name: "Signal Phrase", outputPath: resolveProjectPath("data/stickers/2/design.png"), width: 1000, height: 1000 },
    { id: 3, name: "Tagline", outputPath: resolveProjectPath("data/stickers/3/design.png"), width: 1000, height: 1000 },
    { id: 4, name: "FSC Badge", outputPath: resolveProjectPath("data/stickers/4/design.png"), width: 1000, height: 1000 },
    { id: 5, name: "Chevron Mark", outputPath: resolveProjectPath("data/stickers/5/design.png"), width: 1000, height: 1000 },
    { id: 6, name: "Redacted", outputPath: resolveProjectPath("data/stickers/6/design.png"), width: 1000, height: 1000 },
    { id: 7, name: "Alert Status", outputPath: resolveProjectPath("data/stickers/7/design.png"), width: 1000, height: 1000 },
    { id: 8, name: "After Action", outputPath: resolveProjectPath("data/stickers/8/design.png"), width: 1000, height: 1000 },
    { id: 9, name: "Operationally Sound", outputPath: resolveProjectPath("data/stickers/9/design.png"), width: 1000, height: 1000 },
    { id: 10, name: "Grid Mark", outputPath: resolveProjectPath("data/stickers/10/design.png"), width: 1000, height: 1000 },
  ];
}

/**
 * Builds the deterministic SVG for one branded sticker asset.
 */
function buildStickerSvg(stickerId: number): string {
  const transparentSvgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">`;
  const transparentSvgClose = "</svg>";

  switch (stickerId) {
    case 1:
      return `
${transparentSvgOpen}
  <circle cx="500" cy="500" r="430" fill="${COLOR_BG}" stroke="${COLOR_CYAN}" stroke-width="8" />
  <line x1="180" y1="430" x2="820" y2="430" stroke="${COLOR_CYAN}" stroke-width="4" />
  <text x="500" y="525" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="72" font-weight="700" letter-spacing="6">FEINT SUPPLY CO.</text>
  <line x1="180" y1="575" x2="820" y2="575" stroke="${COLOR_CYAN}" stroke-width="4" />
${transparentSvgClose}
      `.trim();
    case 2:
      return `
${transparentSvgOpen}
  <rect x="120" y="220" width="760" height="560" rx="42" fill="${COLOR_BG}" stroke="${COLOR_CYAN}" stroke-width="6" />
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="10" stroke-linecap="round">
    <path d="M 450 350 L 500 380" />
    <path d="M 450 410 L 500 380" />
  </g>
  <text x="500" y="545" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="58" font-weight="700">SIGNAL OVER NOISE.</text>
${transparentSvgClose}
      `.trim();
    case 3:
      return `
${transparentSvgOpen}
  <rect x="110" y="210" width="780" height="580" rx="36" fill="${COLOR_BG}" />
  <text x="500" y="455" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="68" font-weight="700">BUILT DIFFERENT.</text>
  <line x1="220" y1="520" x2="780" y2="520" stroke="${COLOR_AMBER}" stroke-width="6" />
  <text x="500" y="605" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="42">BY PEOPLE WHO WERE.</text>
${transparentSvgClose}
      `.trim();
    case 4:
      return `
${transparentSvgOpen}
  <circle cx="500" cy="500" r="410" fill="${COLOR_BG}" stroke="${COLOR_CYAN}" stroke-width="8" />
  <text x="500" y="540" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="178" font-weight="700" letter-spacing="8">FSC</text>
  <text x="500" y="635" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="28">FEINT SUPPLY CO.</text>
${transparentSvgClose}
      `.trim();
    case 5:
      return `
${transparentSvgOpen}
  <rect x="130" y="130" width="740" height="740" rx="40" fill="${COLOR_BG}" />
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="18" stroke-linecap="round">
    <path d="M 400 360 L 520 430" />
    <path d="M 400 500 L 520 430" />
  </g>
  <text x="500" y="630" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="92" font-weight="700" letter-spacing="10">FEINT</text>
${transparentSvgClose}
      `.trim();
    case 6:
      return `
${transparentSvgOpen}
  <rect x="120" y="180" width="760" height="640" rx="32" fill="${COLOR_BG}" />
  <text x="500" y="445" text-anchor="middle" fill="${COLOR_TEXT}" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="700">████████ SUPPLY CO.</text>
  <g transform="translate(500 560) rotate(-15)">
    <rect x="-210" y="-52" width="420" height="104" fill="none" stroke="#F85149" stroke-width="8" />
    <text x="0" y="18" text-anchor="middle" fill="#F85149" font-family="Arial, Helvetica, sans-serif" font-size="56" font-weight="700">CLASSIFIED</text>
  </g>
${transparentSvgClose}
      `.trim();
    case 7:
      return `
${transparentSvgOpen}
  <rect x="100" y="160" width="800" height="680" rx="28" fill="${COLOR_BG}" />
  <text x="180" y="380" fill="#2EA043" font-family="Courier New, monospace" font-size="32">&gt; STATUS: OPERATIONAL</text>
  <text x="180" y="465" fill="#2EA043" font-family="Courier New, monospace" font-size="32">&gt; THREAT LEVEL: NOMINAL</text>
  <text x="180" y="550" fill="#2EA043" font-family="Courier New, monospace" font-size="32">&gt; SIGNAL: CLEAN</text>
  <rect x="180" y="592" width="18" height="32" fill="#2EA043" opacity="0.85" />
${transparentSvgClose}
      `.trim();
    case 8:
      return `
${transparentSvgOpen}
  <rect x="120" y="210" width="760" height="580" rx="30" fill="${COLOR_BG}" />
  <text x="500" y="450" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="52" font-weight="700">AFTER ACTION REPORT</text>
  <line x1="250" y1="510" x2="750" y2="510" stroke="${COLOR_AMBER}" stroke-width="5" />
  <text x="500" y="585" text-anchor="middle" fill="#8B949E" font-family="Arial, Helvetica, sans-serif" font-size="30" font-style="italic">SURVIVED ANOTHER ONE</text>
${transparentSvgClose}
      `.trim();
    case 9:
      return `
${transparentSvgOpen}
  <rect x="110" y="225" width="780" height="550" rx="34" fill="${COLOR_BG}" />
  <text x="500" y="455" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="46" font-weight="700">OPERATIONALLY SOUND.</text>
  <text x="500" y="560" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="38">EMOTIONALLY QUESTIONABLE.</text>
${transparentSvgClose}
      `.trim();
    case 10:
      return `
${transparentSvgOpen}
  ${buildGridPattern("sticker-grid", 70, COLOR_BG_ALT, 1)}
  <rect x="120" y="120" width="760" height="760" rx="30" fill="${COLOR_BG}" />
  <rect x="120" y="120" width="760" height="760" rx="30" fill="url(#sticker-grid)" />
  <line x1="500" y1="220" x2="500" y2="780" stroke="${COLOR_CYAN}" stroke-width="3" />
  <line x1="220" y1="500" x2="780" y2="500" stroke="${COLOR_CYAN}" stroke-width="3" />
  <circle cx="500" cy="500" r="42" fill="none" stroke="${COLOR_CYAN}" stroke-width="3" />
  <text x="500" y="520" text-anchor="middle" fill="${COLOR_AMBER}" font-family="${FONT_PRIMARY}" font-size="56" font-weight="700">FSC</text>
  <text x="170" y="170" fill="#8B949E" font-family="Courier New, monospace" font-size="18">34.21N</text>
  <text x="760" y="170" fill="#8B949E" font-family="Courier New, monospace" font-size="18">118.49W</text>
  <text x="170" y="840" fill="#8B949E" font-family="Courier New, monospace" font-size="18">GRID REF</text>
  <text x="720" y="840" fill="#8B949E" font-family="Courier New, monospace" font-size="18">FEINT-01</text>
${transparentSvgClose}
      `.trim();
    default:
      throw new Error(`Unsupported sticker design id: ${stickerId}`);
  }
}

/**
 * Generates one deterministic sticker PNG for the Feint sticker collection.
 */
export async function generateStickerDesign(stickerId: number): Promise<StickerDesignRecord> {
  const manifestEntry = getStickerDesignManifest().find((entry) => entry.id === stickerId);
  if (!manifestEntry) {
    throw new Error(`No sticker design manifest entry exists for sticker ${stickerId}.`);
  }

  await ensureStickerDirectory(stickerId);
  const svg = buildStickerSvg(stickerId);
  await writeFile(resolveProjectPath(`data/stickers/${stickerId}/design.svg`), `${svg}\n`, "utf8");
  await renderSvgToPng(svg, manifestEntry.outputPath, manifestEntry.width, manifestEntry.height);
  return manifestEntry;
}

/**
 * Generates the full deterministic sticker set for preview or live publishing.
 */
export async function generateStickerDesignSet(): Promise<StickerDesignRecord[]> {
  const manifest = getStickerDesignManifest();
  for (const entry of manifest) {
    await generateStickerDesign(entry.id);
  }
  return manifest;
}

/**
 * Makes sure the t-shirt output directory exists before deterministic DTG art is written.
 */
async function ensureTshirtDirectory(designId: number): Promise<string> {
  const directoryPath = resolveProjectPath(`data/tshirts/${designId}`);
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

/**
 * Returns the stable manifest for the Feint Supply Co. t-shirt collection.
 */
export function getTshirtDesignManifest(): TshirtDesignRecord[] {
  return [
    { id: 1, name: "Signal Wordmark", outputPath: resolveProjectPath("data/tshirts/1/design.png"), width: 4500, height: 5400 },
    { id: 2, name: "Redacted", outputPath: resolveProjectPath("data/tshirts/2/design.png"), width: 4500, height: 5400 },
    { id: 3, name: "Operationally Sound", outputPath: resolveProjectPath("data/tshirts/3/design.png"), width: 4500, height: 5400 },
    { id: 4, name: "Terminal Status", outputPath: resolveProjectPath("data/tshirts/4/design.png"), width: 4500, height: 5400 },
    { id: 5, name: "FSC Chevron", outputPath: resolveProjectPath("data/tshirts/5/design.png"), width: 4500, height: 5400 },
    { id: 6, name: "After Action", outputPath: resolveProjectPath("data/tshirts/6/design.png"), width: 4500, height: 5400 },
  ];
}

/**
 * Builds deterministic DTG-ready SVG artwork for the Feint Supply Co. t-shirt collection.
 */
function buildTshirtSvg(designId: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="4500" height="5400" viewBox="0 0 4500 5400">`;
  const close = "</svg>";

  switch (designId) {
    case 1:
      return `
${open}
  <line x1="1050" y1="1700" x2="3450" y2="1700" stroke="${COLOR_CYAN}" stroke-width="16" />
  <text x="2250" y="2100" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="280" font-weight="700" letter-spacing="22">FEINT SUPPLY CO.</text>
  <line x1="1050" y1="2250" x2="3450" y2="2250" stroke="${COLOR_CYAN}" stroke-width="16" />
  <text x="2250" y="2500" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="120">SIGNAL OVER NOISE.</text>
${close}
      `.trim();
    case 2:
      return `
${open}
  <text x="2250" y="2200" text-anchor="middle" fill="${COLOR_TEXT}" font-family="Arial, Helvetica, sans-serif" font-size="290" font-weight="700">████████ SUPPLY CO.</text>
  <g transform="translate(2250 2750) rotate(-13)">
    <rect x="-1080" y="-180" width="2160" height="360" fill="none" stroke="#F85149" stroke-width="28" />
    <text x="0" y="78" text-anchor="middle" fill="#F85149" font-family="Arial, Helvetica, sans-serif" font-size="220" font-weight="700">CLASSIFIED</text>
  </g>
${close}
      `.trim();
    case 3:
      return `
${open}
  <text x="2250" y="2100" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="260" font-weight="700">OPERATIONALLY SOUND.</text>
  <text x="2250" y="2480" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="150">EMOTIONALLY QUESTIONABLE.</text>
${close}
      `.trim();
    case 4:
      return `
${open}
  <text x="1180" y="1820" fill="#2EA043" font-family="Courier New, monospace" font-size="150">&gt; OPERATOR: ONLINE</text>
  <text x="1180" y="2080" fill="#2EA043" font-family="Courier New, monospace" font-size="150">&gt; THREAT LEVEL: NOMINAL</text>
  <text x="1180" y="2340" fill="#2EA043" font-family="Courier New, monospace" font-size="150">&gt; SIGNAL: CLEAN</text>
  <text x="1180" y="2600" fill="#2EA043" font-family="Courier New, monospace" font-size="150">&gt; STATUS: FEINT</text>
  <rect x="1180" y="2680" width="84" height="150" fill="#2EA043" opacity="0.9" />
${close}
      `.trim();
    case 5:
      return `
${open}
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="70" stroke-linecap="round">
    <path d="M 1840 1700 L 2250 1940" />
    <path d="M 1840 2180 L 2250 1940" />
  </g>
  <text x="2250" y="2500" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="250" font-weight="700" letter-spacing="18">FEINT SUPPLY CO.</text>
  <text x="2250" y="2760" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="110">EST. 2026</text>
${close}
      `.trim();
    case 6:
      return `
${open}
  <text x="2250" y="2050" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="250" font-weight="700">AFTER ACTION REPORT</text>
  <line x1="1320" y1="2230" x2="3180" y2="2230" stroke="${COLOR_AMBER}" stroke-width="20" />
  <text x="2250" y="2525" text-anchor="middle" fill="#8B949E" font-family="Arial, Helvetica, sans-serif" font-size="140" font-style="italic">SURVIVED ANOTHER ONE</text>
${close}
      `.trim();
    default:
      throw new Error(`Unsupported t-shirt design id: ${designId}.`);
  }
}

/**
 * Generates one deterministic t-shirt PNG for DTG production.
 */
export async function generateTshirtDesign(designId: number): Promise<TshirtDesignRecord> {
  const manifestEntry = getTshirtDesignManifest().find((entry) => entry.id === designId);
  if (!manifestEntry) {
    throw new Error(`No t-shirt design manifest entry exists for design ${designId}.`);
  }

  await ensureTshirtDirectory(designId);
  const svg = buildTshirtSvg(designId);
  await writeFile(resolveProjectPath(`data/tshirts/${designId}/design.svg`), `${svg}\n`, "utf8");
  await renderSvgToPng(svg, manifestEntry.outputPath, manifestEntry.width, manifestEntry.height);
  return manifestEntry;
}

/**
 * Generates the full deterministic t-shirt design set for preview or live product creation.
 */
export async function generateTshirtDesignSet(): Promise<TshirtDesignRecord[]> {
  const manifest = getTshirtDesignManifest();
  for (const entry of manifest) {
    await generateTshirtDesign(entry.id);
  }
  return manifest;
}

/**
 * Returns the stable manifest for the Feint Supply Co. mug collection.
 */
export function getMugDesignManifest(): MugDesignRecord[] {
  return [
    { id: 1, name: "Signal Wrap", outputPath: resolveProjectPath("data/mugs/1/design.png"), width: 3800, height: 1800 },
    { id: 2, name: "Chevron Brief", outputPath: resolveProjectPath("data/mugs/2/design.png"), width: 3800, height: 1800 },
    { id: 3, name: "Terminal Status", outputPath: resolveProjectPath("data/mugs/3/design.png"), width: 3800, height: 1800 },
    { id: 4, name: "After Action", outputPath: resolveProjectPath("data/mugs/4/design.png"), width: 3800, height: 1800 },
    { id: 5, name: "Grid Mark", outputPath: resolveProjectPath("data/mugs/5/design.png"), width: 3800, height: 1800 },
    { id: 6, name: "Redacted Wrap", outputPath: resolveProjectPath("data/mugs/6/design.png"), width: 3800, height: 1800 },
  ];
}

/**
 * Builds deterministic wrap-around mug artwork with safe margins near the handle.
 */
function buildMugSvg(designId: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="3800" height="1800" viewBox="0 0 3800 1800">`;
  const close = "</svg>";

  switch (designId) {
    case 1:
      return `
${open}
  <line x1="520" y1="700" x2="3280" y2="700" stroke="${COLOR_CYAN}" stroke-width="12" />
  <text x="1900" y="930" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="210" font-weight="700" letter-spacing="18">FEINT SUPPLY CO.</text>
  <line x1="520" y1="1010" x2="3280" y2="1010" stroke="${COLOR_CYAN}" stroke-width="12" />
  <text x="1900" y="1170" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="82">SIGNAL OVER NOISE.</text>
${close}
      `.trim();
    case 2:
      return `
${open}
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="42" stroke-linecap="round">
    <path d="M 980 720 L 1180 840" />
    <path d="M 980 960 L 1180 840" />
    <path d="M 2620 720 L 2820 840" />
    <path d="M 2620 960 L 2820 840" />
  </g>
  <text x="1900" y="910" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="170" font-weight="700" letter-spacing="14">QUIET PROFESSIONAL</text>
  <text x="1900" y="1080" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="72">LOW PROFILE. HIGH SIGNAL.</text>
${close}
      `.trim();
    case 3:
      return `
${open}
  <rect x="620" y="500" width="2560" height="760" rx="28" fill="${COLOR_BG}" />
  <text x="820" y="760" fill="#2EA043" font-family="Courier New, monospace" font-size="84">&gt; OPERATOR: ONLINE</text>
  <text x="820" y="930" fill="#2EA043" font-family="Courier New, monospace" font-size="84">&gt; THREAT LEVEL: NOMINAL</text>
  <text x="820" y="1100" fill="#2EA043" font-family="Courier New, monospace" font-size="84">&gt; SIGNAL: CLEAN</text>
${close}
      `.trim();
    case 4:
      return `
${open}
  <text x="1900" y="820" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="178" font-weight="700">AFTER ACTION REPORT</text>
  <line x1="1080" y1="940" x2="2720" y2="940" stroke="${COLOR_AMBER}" stroke-width="18" />
  <text x="1900" y="1110" text-anchor="middle" fill="#8B949E" font-family="Arial, Helvetica, sans-serif" font-size="88" font-style="italic">SURVIVED ANOTHER ONE</text>
${close}
      `.trim();
    case 5:
      return `
${open}
  ${buildGridPattern("mug-grid", 120, COLOR_BG_ALT, 1)}
  <rect x="620" y="340" width="2560" height="1120" rx="24" fill="${COLOR_BG}" />
  <rect x="620" y="340" width="2560" height="1120" rx="24" fill="url(#mug-grid)" />
  <line x1="1900" y1="520" x2="1900" y2="1280" stroke="${COLOR_CYAN}" stroke-width="8" />
  <line x1="1160" y1="900" x2="2640" y2="900" stroke="${COLOR_CYAN}" stroke-width="8" />
  <circle cx="1900" cy="900" r="110" fill="none" stroke="${COLOR_CYAN}" stroke-width="8" />
  <text x="1900" y="940" text-anchor="middle" fill="${COLOR_AMBER}" font-family="${FONT_PRIMARY}" font-size="120" font-weight="700">FSC</text>
${close}
      `.trim();
    case 6:
      return `
${open}
  <text x="1900" y="860" text-anchor="middle" fill="${COLOR_TEXT}" font-family="Arial, Helvetica, sans-serif" font-size="180" font-weight="700">REDACTED SUPPLY CO.</text>
  <g transform="translate(1900 1040) rotate(-8)">
    <rect x="-980" y="-120" width="1960" height="240" fill="none" stroke="#F85149" stroke-width="22" />
    <text x="0" y="46" text-anchor="middle" fill="#F85149" font-family="Arial, Helvetica, sans-serif" font-size="140" font-weight="700">CLASSIFIED</text>
  </g>
${close}
      `.trim();
    default:
      throw new Error(`Unsupported mug design id: ${designId}.`);
  }
}

/**
 * Generates one deterministic mug PNG for wrap-around production.
 */
export async function generateMugDesign(designId: number): Promise<MugDesignRecord> {
  return writeProgrammaticProductDesign("mugs", getMugDesignManifest(), designId, buildMugSvg);
}

/**
 * Generates the full deterministic mug design set for preview or live product preparation.
 */
export async function generateMugDesignSet(): Promise<MugDesignRecord[]> {
  const manifest = getMugDesignManifest();
  for (const entry of manifest) {
    await generateMugDesign(entry.id);
  }
  return manifest;
}

/**
 * Returns the stable manifest for the Feint Supply Co. poster collection.
 */
export function getPosterDesignManifest(): PosterDesignRecord[] {
  return [
    { id: 1, name: "Signal Over Noise", outputPath: resolveProjectPath("data/posters/1/design.png"), width: 3600, height: 5400 },
    { id: 2, name: "Quiet Professional", outputPath: resolveProjectPath("data/posters/2/design.png"), width: 3600, height: 5400 },
    { id: 3, name: "Grid Dossier", outputPath: resolveProjectPath("data/posters/3/design.png"), width: 3600, height: 5400 },
    { id: 4, name: "Terminal Bulletin", outputPath: resolveProjectPath("data/posters/4/design.png"), width: 3600, height: 5400 },
    { id: 5, name: "Chevron Hero", outputPath: resolveProjectPath("data/posters/5/design.png"), width: 3600, height: 5400 },
    { id: 6, name: "Operationally Sound", outputPath: resolveProjectPath("data/posters/6/design.png"), width: 3600, height: 5400 },
  ];
}

/**
 * Builds deterministic portrait poster art with more room for detailed composition and typography.
 */
function buildPosterSvg(designId: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="3600" height="5400" viewBox="0 0 3600 5400">`;
  const close = "</svg>";

  switch (designId) {
    case 1:
      return `
${open}
  ${buildGridPattern("poster-grid-1", 120, COLOR_BG_ALT, 0.8)}
  <rect width="3600" height="5400" fill="${COLOR_BG}" />
  <rect width="3600" height="5400" fill="url(#poster-grid-1)" />
  <line x1="620" y1="1500" x2="2980" y2="1500" stroke="${COLOR_CYAN}" stroke-width="14" />
  <text x="1800" y="2100" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="280" font-weight="700" letter-spacing="20">SIGNAL</text>
  <text x="1800" y="2480" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_PRIMARY}" font-size="220" font-weight="700" letter-spacing="20">OVER NOISE.</text>
  <line x1="620" y1="2740" x2="2980" y2="2740" stroke="${COLOR_AMBER}" stroke-width="14" />
  <text x="1800" y="3070" text-anchor="middle" fill="#8B949E" font-family="${FONT_MONO}" font-size="84">FEINT SUPPLY CO.</text>
${close}
      `.trim();
    case 2:
      return `
${open}
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="64" stroke-linecap="round">
    <path d="M 1200 1320 L 1800 1670" />
    <path d="M 1200 2020 L 1800 1670" />
  </g>
  <text x="1800" y="2740" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="238" font-weight="700">QUIET</text>
  <text x="1800" y="3060" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="238" font-weight="700">PROFESSIONAL</text>
  <text x="1800" y="3440" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="96">LOW PROFILE. HIGH STANDARDS.</text>
${close}
      `.trim();
    case 3:
      return `
${open}
  ${buildGridPattern("poster-grid-3", 160, COLOR_BG_ALT, 1)}
  <rect width="3600" height="5400" fill="${COLOR_BG}" />
  <rect width="3600" height="5400" fill="url(#poster-grid-3)" />
  <rect x="560" y="760" width="2480" height="3880" rx="36" fill="none" stroke="${COLOR_CYAN}" stroke-width="10" />
  <line x1="1800" y1="1040" x2="1800" y2="4360" stroke="${COLOR_CYAN}" stroke-width="6" />
  <line x1="880" y1="2700" x2="2720" y2="2700" stroke="${COLOR_CYAN}" stroke-width="6" />
  <circle cx="1800" cy="2700" r="160" fill="none" stroke="${COLOR_AMBER}" stroke-width="10" />
  <text x="1800" y="2760" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="160" font-weight="700">FSC</text>
  <text x="760" y="1180" fill="#8B949E" font-family="${FONT_MONO}" font-size="44">GRID REF: FEINT-01</text>
  <text x="2240" y="4220" fill="#8B949E" font-family="${FONT_MONO}" font-size="44">34.21N / 118.49W</text>
${close}
      `.trim();
    case 4:
      return `
${open}
  <rect width="3600" height="5400" fill="${COLOR_BG}" />
  <text x="740" y="1840" fill="#2EA043" font-family="Courier New, monospace" font-size="136">&gt; PRIORITY: CLEAN SIGNAL</text>
  <text x="740" y="2200" fill="#2EA043" font-family="Courier New, monospace" font-size="136">&gt; STATUS: OPERATIONAL</text>
  <text x="740" y="2560" fill="#2EA043" font-family="Courier New, monospace" font-size="136">&gt; NOISE FLOOR: LOW</text>
  <text x="740" y="2920" fill="#2EA043" font-family="Courier New, monospace" font-size="136">&gt; NEXT ACTION: EXECUTE</text>
  <rect x="740" y="3040" width="92" height="136" fill="#2EA043" opacity="0.9" />
${close}
      `.trim();
    case 5:
      return `
${open}
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="110" stroke-linecap="round">
    <path d="M 1360 1700 L 1800 1960" />
    <path d="M 1360 2220 L 1800 1960" />
  </g>
  <text x="1800" y="3020" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="236" font-weight="700" letter-spacing="18">FEINT SUPPLY CO.</text>
  <line x1="920" y1="3220" x2="2680" y2="3220" stroke="${COLOR_CYAN}" stroke-width="12" />
  <text x="1800" y="3500" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="88">VETERAN OWNED. MODERN SIGNAL.</text>
${close}
      `.trim();
    case 6:
      return `
${open}
  <text x="1800" y="2220" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="210" font-weight="700">OPERATIONALLY SOUND.</text>
  <text x="1800" y="2620" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="118">EMOTIONALLY QUESTIONABLE.</text>
  <line x1="840" y1="2860" x2="2760" y2="2860" stroke="${COLOR_AMBER}" stroke-width="16" />
  <text x="1800" y="3200" text-anchor="middle" fill="#8B949E" font-family="Arial, Helvetica, sans-serif" font-size="84" font-style="italic">BUILT DIFFERENT. BY PEOPLE WHO WERE.</text>
${close}
      `.trim();
    default:
      throw new Error(`Unsupported poster design id: ${designId}.`);
  }
}

/**
 * Generates one deterministic poster PNG for full-size wall-art production.
 */
export async function generatePosterDesign(designId: number): Promise<PosterDesignRecord> {
  return writeProgrammaticProductDesign("posters", getPosterDesignManifest(), designId, buildPosterSvg);
}

/**
 * Generates the full deterministic poster design set for preview or live product preparation.
 */
export async function generatePosterDesignSet(): Promise<PosterDesignRecord[]> {
  const manifest = getPosterDesignManifest();
  for (const entry of manifest) {
    await generatePosterDesign(entry.id);
  }
  return manifest;
}

/**
 * Returns the stable manifest for the Feint Supply Co. hoodie collection.
 */
export function getHoodieDesignManifest(): HoodieDesignRecord[] {
  return [
    { id: 1, name: "Signal Wordmark", outputPath: resolveProjectPath("data/hoodies/1/design.png"), width: 4500, height: 5400 },
    { id: 2, name: "Redacted", outputPath: resolveProjectPath("data/hoodies/2/design.png"), width: 4500, height: 5400 },
    { id: 3, name: "Operationally Sound", outputPath: resolveProjectPath("data/hoodies/3/design.png"), width: 4500, height: 5400 },
    { id: 4, name: "Terminal Status", outputPath: resolveProjectPath("data/hoodies/4/design.png"), width: 4500, height: 5400 },
    { id: 5, name: "Chevron Mark", outputPath: resolveProjectPath("data/hoodies/5/design.png"), width: 4500, height: 5400 },
    { id: 6, name: "After Action", outputPath: resolveProjectPath("data/hoodies/6/design.png"), width: 4500, height: 5400 },
  ];
}

/**
 * Builds deterministic hoodie artwork sized like apparel print files, with chest-print-friendly composition.
 */
function buildHoodieSvg(designId: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="4500" height="5400" viewBox="0 0 4500 5400">`;
  const close = "</svg>";

  switch (designId) {
    case 1:
      return `
${open}
  <line x1="1280" y1="1760" x2="3220" y2="1760" stroke="${COLOR_CYAN}" stroke-width="18" />
  <text x="2250" y="2140" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="250" font-weight="700" letter-spacing="20">FEINT SUPPLY CO.</text>
  <line x1="1280" y1="2260" x2="3220" y2="2260" stroke="${COLOR_CYAN}" stroke-width="18" />
  <text x="2250" y="2500" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="108">SIGNAL OVER NOISE.</text>
${close}
      `.trim();
    case 2:
      return `
${open}
  <text x="2250" y="2200" text-anchor="middle" fill="${COLOR_TEXT}" font-family="Arial, Helvetica, sans-serif" font-size="270" font-weight="700">REDACTED SUPPLY CO.</text>
  <g transform="translate(2250 2700) rotate(-11)">
    <rect x="-980" y="-160" width="1960" height="320" fill="none" stroke="#F85149" stroke-width="24" />
    <text x="0" y="68" text-anchor="middle" fill="#F85149" font-family="Arial, Helvetica, sans-serif" font-size="180" font-weight="700">CLASSIFIED</text>
  </g>
${close}
      `.trim();
    case 3:
      return `
${open}
  <text x="2250" y="2140" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="230" font-weight="700">OPERATIONALLY SOUND.</text>
  <text x="2250" y="2480" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="132">EMOTIONALLY QUESTIONABLE.</text>
${close}
      `.trim();
    case 4:
      return `
${open}
  <text x="1260" y="1820" fill="#2EA043" font-family="Courier New, monospace" font-size="132">&gt; OPERATOR: ONLINE</text>
  <text x="1260" y="2080" fill="#2EA043" font-family="Courier New, monospace" font-size="132">&gt; THREAT LEVEL: NOMINAL</text>
  <text x="1260" y="2340" fill="#2EA043" font-family="Courier New, monospace" font-size="132">&gt; SIGNAL: CLEAN</text>
  <rect x="1260" y="2440" width="78" height="132" fill="#2EA043" opacity="0.9" />
${close}
      `.trim();
    case 5:
      return `
${open}
  <g fill="none" stroke="${COLOR_AMBER}" stroke-width="64" stroke-linecap="round">
    <path d="M 1780 1700 L 2250 1980" />
    <path d="M 1780 2260 L 2250 1980" />
  </g>
  <text x="2250" y="2520" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="230" font-weight="700" letter-spacing="16">FEINT SUPPLY CO.</text>
  <text x="2250" y="2760" text-anchor="middle" fill="${COLOR_CYAN}" font-family="${FONT_MONO}" font-size="98">CHEST PRINT / BACK-UP SIGNAL</text>
${close}
      `.trim();
    case 6:
      return `
${open}
  <text x="2250" y="2080" text-anchor="middle" fill="${COLOR_TEXT}" font-family="${FONT_PRIMARY}" font-size="228" font-weight="700">AFTER ACTION REPORT</text>
  <line x1="1360" y1="2260" x2="3140" y2="2260" stroke="${COLOR_AMBER}" stroke-width="18" />
  <text x="2250" y="2540" text-anchor="middle" fill="#8B949E" font-family="Arial, Helvetica, sans-serif" font-size="124" font-style="italic">SURVIVED ANOTHER ONE</text>
${close}
      `.trim();
    default:
      throw new Error(`Unsupported hoodie design id: ${designId}.`);
  }
}

/**
 * Generates one deterministic hoodie PNG for apparel production.
 */
export async function generateHoodieDesign(designId: number): Promise<HoodieDesignRecord> {
  return writeProgrammaticProductDesign("hoodies", getHoodieDesignManifest(), designId, buildHoodieSvg);
}

/**
 * Generates the full deterministic hoodie design set for preview or live product preparation.
 */
export async function generateHoodieDesignSet(): Promise<HoodieDesignRecord[]> {
  const manifest = getHoodieDesignManifest();
  for (const entry of manifest) {
    await generateHoodieDesign(entry.id);
  }
  return manifest;
}

/**
 * Returns the stable manifest of all brand assets the compositor writes.
 */
export function getBrandAssetManifest(): BrandAssetRecord[] {
  return [
    { filename: "logo-primary.png", outputPath: resolveProjectPath("data/brand/logo-primary.png"), width: 1024, height: 1024 },
    { filename: "logo-dark.png", outputPath: resolveProjectPath("data/brand/logo-dark.png"), width: 1024, height: 1024 },
    { filename: "logo-light.png", outputPath: resolveProjectPath("data/brand/logo-light.png"), width: 1024, height: 1024 },
    { filename: "logo-icon.png", outputPath: resolveProjectPath("data/brand/logo-icon.png"), width: 500, height: 500 },
    { filename: "profile-icon.png", outputPath: resolveProjectPath("data/brand/profile-icon.png"), width: 500, height: 500 },
    { filename: "shop-banner.png", outputPath: resolveProjectPath("data/brand/shop-banner.png"), width: 3360, height: 840 },
    { filename: "banner.png", outputPath: resolveProjectPath("data/brand/banner.png"), width: 3360, height: 840 },
    { filename: "pinterest-template.png", outputPath: resolveProjectPath("data/brand/pinterest-template.png"), width: 1000, height: 1500 },
    { filename: "social-header.png", outputPath: resolveProjectPath("data/brand/social-header.png"), width: 1500, height: 500 },
    { filename: "email-header.png", outputPath: resolveProjectPath("data/brand/email-header.png"), width: 600, height: 200 },
    { filename: "watermark.png", outputPath: resolveProjectPath("data/brand/watermark.png"), width: 400, height: 100 },
  ];
}

/**
 * Generates the full deterministic brand package and returns the asset manifest.
 */
export async function generateProgrammaticBrandAssets(): Promise<BrandAssetRecord[]> {
  await ensureBrandDirectory();
  await loadBrandGuide();

  await writeSvgSource("logo-primary.svg", buildPrimaryLogoSvg());
  await writeSvgSource("logo-dark.svg", buildDarkLogoSvg());
  await writeSvgSource("logo-light.svg", buildLightLogoSvg());
  await writeSvgSource("logo-icon.svg", buildIconSvg());
  await writeSvgSource("shop-banner-base.svg", buildBannerBaseSvg());
  await writeSvgSource("shop-banner-text.svg", buildBannerTextSvg());
  await writeSvgSource("pinterest-template.svg", buildPinterestTemplateSvg());
  await writeSvgSource("social-header.svg", buildSocialHeaderSvg());
  await writeSvgSource("email-header.svg", buildEmailHeaderSvg());
  await writeSvgSource("watermark.svg", buildWatermarkSvg());

  await renderSvgToPng(buildPrimaryLogoSvg(), resolveProjectPath("data/brand/logo-primary.png"), 1024, 1024);
  await renderSvgToPng(buildDarkLogoSvg(), resolveProjectPath("data/brand/logo-dark.png"), 1024, 1024);
  await renderSvgToPng(buildLightLogoSvg(), resolveProjectPath("data/brand/logo-light.png"), 1024, 1024);
  await renderSvgToPng(buildIconSvg(), resolveProjectPath("data/brand/logo-icon.png"), 500, 500);
  await copyFile(resolveProjectPath("data/brand/logo-icon.png"), resolveProjectPath("data/brand/profile-icon.png"));
  await renderBanner(resolveProjectPath("data/brand/shop-banner.png"));
  await copyFile(resolveProjectPath("data/brand/shop-banner.png"), resolveProjectPath("data/brand/banner.png"));
  await renderSvgToPng(buildPinterestTemplateSvg(), resolveProjectPath("data/brand/pinterest-template.png"), 1000, 1500);
  await renderSvgToPng(buildSocialHeaderSvg(), resolveProjectPath("data/brand/social-header.png"), 1500, 500);
  await renderSvgToPng(buildEmailHeaderSvg(), resolveProjectPath("data/brand/email-header.png"), 600, 200);
  await renderSvgToPng(buildWatermarkSvg(), resolveProjectPath("data/brand/watermark.png"), 400, 100);

  return getBrandAssetManifest();
}
