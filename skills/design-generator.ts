import "dotenv/config";

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DesignRecord,
  createDesignRecord,
  getDailyDesignSpend,
  getDesignById,
  initializeDatabase,
  resolveProjectPath,
  setAutomationControl,
  updateDesignAssets,
} from "../lib/db.js";
import { assertLegalApproval } from "../lib/legal-filter.js";
import { callLLM, type LlmTaskType } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";
import { ALL_PRODUCT_TYPES, type ProductType } from "../lib/product-types.js";
import { buildDeterministicId, ensureDryRunImage, isDryRunEnabled } from "../lib/runtime.js";
import { auditLog } from "../lib/audit.js";

export interface DesignGenerationInput {
  theme: string;
  productType: ProductType;
  requiresManualReview?: boolean;
  manualReviewReason?: string | null;
  taskTypeOverride?: LlmTaskType;
  trusted?: boolean;
}

interface DesignTemplate {
  productType: string;
  designStyle: string;
  requiresTransparency: boolean;
  targetResolution: string;
  mockupAspectRatios: string[];
  printArea: string;
  promptDirectives?: string[];
}

interface PngMetadata {
  width: number;
  height: number;
  hasAlpha: boolean;
}

const logger = createLogger("design-generator");
const minimumQualityScore = 0.72;

/**
 * Loads the product-specific design template so prompts and quality checks can stay consistent.
 */
async function loadDesignTemplate(productType: DesignGenerationInput["productType"]): Promise<DesignTemplate> {
  const templatePath = resolveProjectPath(`data/design_templates/${productType}.json`);
  const template = JSON.parse(await readFile(templatePath, "utf8")) as DesignTemplate;
  return template;
}

/**
 * Returns the routed task type that best matches the requested product category.
 */
function getDesignTaskType(input: DesignGenerationInput): LlmTaskType {
  if (input.taskTypeOverride) {
    return input.taskTypeOverride;
  }

  const productType = input.productType;
  if (productType === "poster") {
    return "vector_logos";
  }
  if (productType === "mug") {
    return "bulk_variant_generation";
  }
  if (productType === "enamel-pin") {
    return "vector_logos";
  }
  if (productType === "hat") {
    // Embroidered caps read best as clean, simple, limited-color emblems.
    return "vector_logos";
  }
  return "apparel_design_with_text";
}

/**
 * Parses a `WIDTHxHEIGHT` string into numeric dimensions for quality metadata and prompt hints.
 */
function parseResolution(value: string): { width: number; height: number } {
  const [width, height] = value.toLowerCase().split("x").map((part) => Number.parseInt(part, 10));
  return {
    width: Number.isFinite(width) ? width : 3000,
    height: Number.isFinite(height) ? height : 3000,
  };
}

/**
 * Builds the primary print-design prompt from the product template and chosen theme.
 */
function buildPrimaryPrompt(theme: string, template: DesignTemplate): string {
  const directives = template.promptDirectives?.length
    ? ` Specific product requirements: ${template.promptDirectives.join(" ")}`
    : "";
  return `Create a ${template.designStyle} for a ${template.productType} based on the theme "${theme}". Optimize for print-on-demand commerce, ensure text is legible, avoid tiny details, and leave clean margins for the ${template.printArea} print area.${directives} Deliver a polished standalone design asset suitable for AI-assisted commercial art.`;
}

/**
 * Builds a mockup prompt that turns the generated design concept into listing-ready lifestyle photography.
 */
function buildMockupPrompt(theme: string, template: DesignTemplate, variation: number): string {
  return `Create an ecommerce product mockup for a ${template.productType} themed around "${theme}". Variation ${variation}. Show the product in a polished, marketplace-ready scene with strong lighting, crisp focus, and a premium lifestyle presentation.`;
}

/**
 * Reads PNG width, height, and alpha-channel metadata so basic asset quality gates can run locally.
 */
async function readPngMetadata(filePath: string): Promise<PngMetadata> {
  const bytes = await readFile(filePath);
  if (bytes.length < 33) {
    throw new Error(`Generated PNG at ${filePath} was too small to inspect.`);
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes.readUInt8(25);
  return {
    width,
    height,
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

/**
 * Converts local PNG metadata into a single quality score and explanation for downstream decision-making.
 */
async function scoreDesignAssets(
  primaryDesignPath: string,
  mockupPaths: string[],
  template: DesignTemplate,
): Promise<{ score: number; metadata: Record<string, unknown> }> {
  const primaryMetadata = await readPngMetadata(primaryDesignPath);
  const targetResolution = parseResolution(template.targetResolution);
  const resolutionScore = Math.min(primaryMetadata.width / 1024, primaryMetadata.height / 1024, 1);
  const transparencyScore = template.requiresTransparency ? (primaryMetadata.hasAlpha ? 1 : 0.2) : 1;
  const mockupScore = mockupPaths.length === 3 ? 1 : mockupPaths.length / 3;
  const finalScore = Number(((resolutionScore * 0.4) + (transparencyScore * 0.35) + (mockupScore * 0.25)).toFixed(4));

  return {
    score: finalScore,
    metadata: {
      templateTargetResolution: targetResolution,
      observedWidth: primaryMetadata.width,
      observedHeight: primaryMetadata.height,
      transparencyRequired: template.requiresTransparency,
      transparencyDetected: primaryMetadata.hasAlpha,
      mockupCount: mockupPaths.length,
      note: "Text legibility is approximated via provider routing and asset dimensions; human spot checks are still recommended for live campaigns.",
    },
  };
}

/**
 * Prevents new design jobs from starting once the configured daily design budget has been exhausted.
 */
function assertDesignBudgetAvailable(): void {
  const currentSpend = getDailyDesignSpend();
  const dailyBudget = Number.parseFloat(process.env.DAILY_DESIGN_BUDGET_USD ?? "10");
  const conservativeReserve = 0.35;

  if (currentSpend + conservativeReserve > dailyBudget) {
    setAutomationControl(
      "design_generation_paused",
      "true",
      `Daily design budget cap reached. Spend ${currentSpend.toFixed(2)} / ${dailyBudget.toFixed(2)}.`,
    );
    throw new Error(`Daily design budget cap reached. Current spend ${currentSpend.toFixed(2)} / ${dailyBudget.toFixed(2)}.`);
  }
}

/**
 * Runs one image-generation pass and returns the saved paths plus total provider cost.
 */
async function generateAssetPass(
  input: DesignGenerationInput,
  template: DesignTemplate,
  designDirectory: string,
  promptSuffix = "",
): Promise<{ primaryResult: Awaited<ReturnType<typeof callLLM>>; mockupPaths: string[]; totalCost: number }> {
  const primaryDesignPath = resolve(designDirectory, "design.png");
  const primaryResult = await callLLM({
    taskType: getDesignTaskType(input),
    prompt: `${buildPrimaryPrompt(input.theme, template)}${promptSuffix}`,
    destinationPath: primaryDesignPath,
    transparentBackground: template.requiresTransparency,
    size: "1024x1024",
  });

  const mockupPaths: string[] = [];
  let totalCost = primaryResult.costUsd;

  for (let variation = 1; variation <= 3; variation += 1) {
    const mockupPath = resolve(designDirectory, `mockup-${variation}.png`);
    const mockupResult = await callLLM({
      taskType: "photorealistic_mockups",
      prompt: `${buildMockupPrompt(input.theme, template, variation)}${promptSuffix}`,
      destinationPath: mockupPath,
      transparentBackground: false,
      size: "1024x1024",
    });
    mockupPaths.push(mockupResult.destinationPaths?.[0] ?? mockupPath);
    totalCost += mockupResult.costUsd;
  }

  return {
    primaryResult,
    mockupPaths,
    totalCost,
  };
}

/**
 * Generates a primary design plus three listing mockups and stores the resulting asset bundle in the database.
 */
export async function generateDesignBundle(input: DesignGenerationInput): Promise<DesignRecord> {
  await assertLegalApproval({
    theme: input.theme,
    prompt: input.theme,
    realPersonFlag: input.requiresManualReview === true,
    source: "design-generator:theme",
  }, "theme", input.trusted === true);

  if (isDryRunEnabled()) {
    const designId = buildDeterministicId(`design:${input.theme}:${input.productType}`);
    const designDirectory = resolveProjectPath(`data/designs/design-${designId}`);
    const primaryDesignPath = resolve(designDirectory, "design.png");
    const mockupPaths = [1, 2, 3].map((variation) => resolve(designDirectory, `mockup-${variation}.png`));

    await Promise.all([
      ensureDryRunImage(primaryDesignPath),
      ...mockupPaths.map((path) => ensureDryRunImage(path)),
    ]);

    const result: DesignRecord = {
      id: designId,
      theme: input.theme,
      product_type: input.productType,
      image_path: primaryDesignPath,
      print_file_path: primaryDesignPath,
      mockup_paths: JSON.stringify(mockupPaths),
      llm_model_used: "dry-run-placeholder",
      cost_usd: 0,
      quality_score: 0.95,
      created_at: new Date().toISOString(),
      metadata: JSON.stringify({
        dryRun: true,
        note: "Synthetic design bundle generated without external image providers.",
        requiresManualReview: input.requiresManualReview === true,
        manualReviewReason: input.manualReviewReason ?? null,
        trusted: input.trusted === true,
      }),
    };
    logger.action("Dry-run design bundle generated", "skip", {
      designId,
      theme: input.theme,
      productType: input.productType,
    });
    return result;
  }

  initializeDatabase();
  assertDesignBudgetAvailable();

  const template = await loadDesignTemplate(input.productType);
  const design = createDesignRecord({
    theme: input.theme,
    productType: input.productType,
    metadata: {
      stage: "initialized",
      template,
      requiresManualReview: input.requiresManualReview === true,
      manualReviewReason: input.manualReviewReason ?? null,
      trusted: input.trusted === true,
    },
  });

  const designDirectory = resolveProjectPath(`data/designs/design-${design.id}`);
  await mkdir(designDirectory, { recursive: true });

  logger.action("Generating design bundle", "start", {
    designId: design.id,
    theme: input.theme,
    productType: input.productType,
  });

  const primaryDesignPath = resolve(designDirectory, "design.png");
  let generationPass = await generateAssetPass(input, template, designDirectory);
  let quality = await scoreDesignAssets(primaryDesignPath, generationPass.mockupPaths, template);

  if (quality.score < minimumQualityScore) {
    logger.warn("Design quality fell below threshold; retrying once with stronger legibility guidance", {
      designId: design.id,
      score: quality.score,
      threshold: minimumQualityScore,
    });
    generationPass = await generateAssetPass(
      input,
      template,
      designDirectory,
      " Use bolder typography, higher contrast, simpler composition, and stronger product readability.",
    );
    quality = await scoreDesignAssets(primaryDesignPath, generationPass.mockupPaths, template);
  }

  if (quality.score < minimumQualityScore) {
    throw new Error(`Generated design quality ${quality.score.toFixed(2)} stayed below the threshold ${minimumQualityScore.toFixed(2)} after retry.`);
  }

  updateDesignAssets(design.id, {
    imagePath: primaryDesignPath,
    printFilePath: primaryDesignPath,
    mockupPaths: generationPass.mockupPaths,
    llmModelUsed: generationPass.primaryResult.model,
    costUsd: Number(generationPass.totalCost.toFixed(4)),
    qualityScore: quality.score,
    metadata: {
      ...quality.metadata,
      routedTaskType: getDesignTaskType(input),
      totalCostUsd: Number(generationPass.totalCost.toFixed(4)),
      requiresManualReview: input.requiresManualReview === true,
      manualReviewReason: input.manualReviewReason ?? null,
      trusted: input.trusted === true,
    },
  });

  auditLog("design_generated", "feintsupply", {
    theme: input.theme,
    productType: input.productType,
    qualityScore: quality.score,
  }, undefined, design.id);

  logger.action("Generated design bundle", "success", {
    designId: design.id,
    qualityScore: quality.score,
    totalCostUsd: Number(generationPass.totalCost.toFixed(4)),
  });
  return getDesignById(design.id) as DesignRecord;
}

/**
 * Reads CLI flags for standalone design generation.
 */
function parseCliArgs(argv: string[]): DesignGenerationInput {
  const themeIndex = argv.findIndex((argument) => argument === "--theme");
  const productTypeIndex = argv.findIndex((argument) => argument === "--product-type");
  const theme = themeIndex >= 0 ? argv[themeIndex + 1] : "";
  const productType = productTypeIndex >= 0 ? argv[productTypeIndex + 1] : "";

  if (!theme) {
    throw new Error("Missing required --theme argument for design generation.");
  }
  if (!ALL_PRODUCT_TYPES.includes(productType as ProductType)) {
    throw new Error("Missing or invalid --product-type argument. Use sticker, t-shirt, mug, poster, hoodie, or enamel-pin.");
  }

  return {
    theme,
    productType: productType as DesignGenerationInput["productType"],
  };
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone design-generator entry point and prints the saved database record.
 */
async function main(): Promise<void> {
  try {
    const input = parseCliArgs(process.argv.slice(2));
    const design = await generateDesignBundle(input);
    console.log(JSON.stringify(design, null, 2));
  } catch (error) {
    logger.error("Standalone design-generator execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
