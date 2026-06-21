import "dotenv/config";

import { exec } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  generateProgrammaticBrandAssets,
  loadBrandGuide,
  type BrandAssetRecord,
} from "../lib/brand-compositor.js";
import { resolveProjectPath } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";

interface BrandSetupOptions {
  dryRun: boolean;
}

interface BrandAssetResult {
  file: string;
  status: "generated";
  sizeBytes: number;
}

interface BrandSetupResult {
  generated_at: string;
  dry_run: boolean;
  store_name: string;
  tagline: string;
  assets: BrandAssetResult[];
}

interface EtsyUploadSetupLog {
  banner_uploaded: boolean;
  icon_uploaded: boolean;
  banner_manual_required: boolean;
  icon_manual_required: boolean;
  manual_steps_needed: string[];
  timestamp: string;
}

const logger = createLogger("brand-setup");
const generationLogPath = resolveProjectPath("data/brand/generation-log.json");
const setupLogPath = resolveProjectPath("data/brand/setup-log.json");
const manualUploadsPath = resolveProjectPath("data/brand/manual-uploads.txt");
const brandDirectoryPath = resolveProjectPath("data/brand");
const manualUploadUrl = "https://etsy.com/your/shops/BDHandIUnitedStates/edit";

/**
 * Opens the rendered asset folder in Explorer after preview runs so the operator can review files immediately.
 */
function openBrandDirectoryInExplorer(): void {
  exec(`explorer "${brandDirectoryPath}"`, (error) => {
    if (error) {
      logger.warn("Failed to open brand directory in Explorer", {
        brandDirectoryPath,
        error: error.message,
      });
    }
  });
}

/**
 * Reads size metadata for each generated asset so the preview report is easy to audit.
 */
async function buildAssetResults(records: BrandAssetRecord[]): Promise<BrandAssetResult[]> {
  const results: BrandAssetResult[] = [];

  for (const record of records) {
    const fileStat = await stat(record.outputPath);
    results.push({
      file: record.outputPath,
      status: "generated",
      sizeBytes: fileStat.size,
    });
  }

  return results;
}

/**
 * Persists the Etsy upload results for banner and icon in live brand:setup mode.
 */
async function writeSetupLog(log: EtsyUploadSetupLog): Promise<void> {
  await writeFile(setupLogPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

/**
 * Etsy does not expose public banner/icon upload endpoints, so live setup records the required manual upload steps instead.
 */
async function uploadBrandAssetsToEtsy(): Promise<EtsyUploadSetupLog> {
  const bannerPath = resolveProjectPath("data/brand/shop-banner.png");
  const iconPath = resolveProjectPath("data/brand/profile-icon.png");
  const manualInstructions = [
    "MANUAL UPLOAD REQUIRED:",
    `Banner: ${manualUploadUrl}`,
    `  File: ${bannerPath}`,
    `Icon:   ${manualUploadUrl}`,
    `  File: ${iconPath}`,
  ].join("\n");
  const setupLog: EtsyUploadSetupLog = {
    banner_uploaded: false,
    icon_uploaded: false,
    banner_manual_required: true,
    icon_manual_required: true,
    manual_steps_needed: [
      `Banner: ${manualUploadUrl}`,
      `  File: ${bannerPath}`,
      `Icon: ${manualUploadUrl}`,
      `  File: ${iconPath}`,
    ],
    timestamp: new Date().toISOString(),
  };

  logger.warn(manualInstructions);
  await writeFile(manualUploadsPath, `${manualInstructions}\n`, "utf8");
  await writeSetupLog(setupLog);
  return setupLog;
}

/**
 * Generates the deterministic brand package and optionally uploads banner and icon in live mode.
 */
export async function runBrandSetup(options: BrandSetupOptions): Promise<BrandSetupResult> {
  const guide = await loadBrandGuide();
  const assetRecords = await generateProgrammaticBrandAssets();
  const assets = await buildAssetResults(assetRecords);

  const result: BrandSetupResult = {
    generated_at: new Date().toISOString(),
    dry_run: options.dryRun,
    store_name: guide.store_name,
    tagline: guide.tagline,
    assets,
  };

  await writeFile(generationLogPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  if (options.dryRun) {
    openBrandDirectoryInExplorer();
  } else {
    await uploadBrandAssetsToEtsy();
  }

  logger.action("Brand asset run completed", "success", {
    dryRun: options.dryRun,
    files: assets.map((asset) => basename(asset.file)),
  });

  return result;
}

/**
 * Parses CLI flags for preview mode.
 */
function parseCliArgs(argv: string[]): BrandSetupOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Detects direct execution so npm scripts can call this module cleanly.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Standalone entry point for previewing or generating the brand package.
 */
async function main(): Promise<void> {
  const result = await runBrandSetup(parseCliArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution()) {
  await main();
}
