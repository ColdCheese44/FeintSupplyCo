import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const dryRunPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9VE3d2sAAAAASUVORK5CYII=";

/**
 * Returns whether the current process is explicitly running in dry-run mode.
 */
export function isDryRunEnabled(): boolean {
  const value = process.env.DRY_RUN?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Produces a stable positive integer from a seed string so dry-run IDs stay deterministic enough for logs.
 */
export function buildDeterministicId(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

/**
 * Ensures a tiny placeholder PNG exists so dry-run image workflows can return realistic local paths safely.
 */
export async function ensureDryRunImage(destinationPath: string): Promise<string> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, Buffer.from(dryRunPngBase64, "base64"));
  return destinationPath;
}

/**
 * Returns the configured Reddit user agent while preserving a stable project default.
 */
export function getRedditUserAgent(): string {
  return process.env.REDDIT_USER_AGENT?.trim() || "JarvisEtsyAutomation/0.2";
}
