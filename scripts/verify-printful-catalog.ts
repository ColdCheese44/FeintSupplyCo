import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import fetch from "node-fetch";

import { resolveProjectPath } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";

interface PrintfulProduct {
  id: number;
  title?: string;
  name?: string;
}

interface PrintfulVariant {
  id: number;
  name?: string;
  size?: string;
  color?: string;
  color_code?: string;
  availability_status?: string | Array<{ region?: string; status?: string }>;
}

interface CatalogCacheFile {
  sticker: {
    blueprint_id: number;
    variant_ids: number[];
    verified_at: string;
  };
  "t-shirt": {
    blueprint_id: number;
    variant_ids: number[];
    verified_at: string;
  };
}

const logger = createLogger("verify-printful-catalog");
const reportPath = resolveProjectPath("data/printful-catalog-report.txt");
const cachePath = resolveProjectPath("data/printful-catalog-cache.json");

/**
 * Reads the configured Printful token and fails fast when it is missing.
 */
function getToken(): string {
  const token = process.env.PRINTFUL_API_TOKEN?.trim();
  if (!token) {
    throw new Error("PRINTFUL_API_TOKEN is missing.");
  }
  return token;
}

/**
 * Performs one authenticated Printful request and returns the parsed JSON body.
 */
async function requestPrintful(path: string): Promise<any> {
  const response = await fetch(`https://api.printful.com${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Printful request failed for ${path}: ${response.status} ${response.statusText} - ${await response.text()}`);
  }

  return response.json();
}

/**
 * Returns products that match one of the requested name fragments.
 */
function filterProducts(products: PrintfulProduct[], fragments: string[]): PrintfulProduct[] {
  return products.filter((product) => {
    const name = `${product.name ?? product.title ?? ""}`.toLowerCase();
    return fragments.some((fragment) => name.includes(fragment));
  });
}

/**
 * Fetches one product detail document and skips only that product when Printful rejects or drops the detail call.
 */
async function loadProductDetail(product: PrintfulProduct): Promise<{ product: PrintfulProduct; variants: PrintfulVariant[] } | null> {
  try {
    const detail = await requestPrintful(`/products/${product.id}`);
    const variants = (detail.result?.variants ?? []) as PrintfulVariant[];
    return { product, variants };
  } catch (error) {
    logger.warn("Skipping Printful product during catalog verification because the detail lookup failed.", {
      productId: product.id,
      productName: product.name ?? product.title ?? `Product ${product.id}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Loads a required fallback product detail by its known blueprint ID and throws if that one cannot be retrieved.
 */
async function loadRequiredProductDetail(productId: number): Promise<{ product: PrintfulProduct; variants: PrintfulVariant[] }> {
  const detail = await requestPrintful(`/products/${productId}`);
  return {
    product: detail.result?.product as PrintfulProduct,
    variants: (detail.result?.variants ?? []) as PrintfulVariant[],
  };
}

/**
 * Formats a single product block for the human-readable report.
 */
function renderProductBlock(product: PrintfulProduct, variants: PrintfulVariant[]): string[] {
  const title = product.name ?? product.title ?? `Product ${product.id}`;
  const lines = [`  [${product.id}] ${title} - ${variants.length} variants`];
  for (const variant of variants.slice(0, 5)) {
    const label = variant.name ?? ([variant.size, variant.color].filter(Boolean).join(" - ") || `Variant ${variant.id}`);
    const tail = [variant.size, variant.color].filter(Boolean).join(" - ");
    lines.push(`    Variant ${variant.id}: ${label}${tail && !label.includes(tail) ? ` - ${tail}` : ""}`);
  }
  return lines;
}

/**
 * Filters to active black S-2XL variants for the default t-shirt blueprint selection.
 */
function selectBlackTshirtVariants(variants: PrintfulVariant[]): PrintfulVariant[] {
  const wantedSizes = new Set(["s", "m", "l", "xl", "2xl"]);
  return variants.filter((variant) => {
    const availability = Array.isArray(variant.availability_status)
      ? variant.availability_status.some((entry) => `${entry.status ?? ""}`.toLowerCase().includes("in_stock"))
      : (() => {
          const normalized = `${variant.availability_status ?? ""}`.toLowerCase();
          return !normalized || normalized === "active" || normalized.includes("active") || normalized.includes("in_stock");
        })();
    const color = `${variant.color ?? ""}`.toLowerCase();
    const colorCode = `${variant.color_code ?? ""}`.toLowerCase();
    const name = `${variant.name ?? ""}`.toLowerCase();
    const size = `${variant.size ?? ""}`.toLowerCase();
    const isBlack = color.includes("black") || colorCode.includes("000000") || name.includes("black");
    const isWantedSize = wantedSizes.has(size) || [...wantedSizes].some((wanted) => name.includes(` ${wanted}`));
    return availability && isBlack && isWantedSize;
  });
}

/**
 * Verifies the live Printful catalog and writes both human and machine-readable outputs to disk.
 */
export async function runVerifyPrintfulCatalog(): Promise<CatalogCacheFile> {
  const productPayload = await requestPrintful("/products");
  const products = (productPayload.result ?? productPayload.data ?? []) as PrintfulProduct[];

  const stickerProducts = filterProducts(products, ["sticker"]);
  const tshirtProducts = filterProducts(products, ["shirt", "tee"]);

  const stickerDetails = (await Promise.all(stickerProducts.map((product) => loadProductDetail(product))))
    .filter((entry): entry is { product: PrintfulProduct; variants: PrintfulVariant[] } => Boolean(entry));

  const tshirtDetails = (await Promise.all(tshirtProducts.map((product) => loadProductDetail(product))))
    .filter((entry): entry is { product: PrintfulProduct; variants: PrintfulVariant[] } => Boolean(entry));

  const selectedSticker = stickerDetails
    .sort((a, b) => b.variants.length - a.variants.length)[0]
    ?? await loadRequiredProductDetail(358);

  const selectedTshirt = tshirtDetails.find(({ product, variants }) => {
    const name = `${product.name ?? product.title ?? ""}`.toLowerCase();
    return name.includes("unisex") && (name.includes("shirt") || name.includes("tee")) && selectBlackTshirtVariants(variants).length > 0;
  }) ?? await loadRequiredProductDetail(71);

  const stickerVariantIds = selectedSticker.variants.map((variant) => variant.id);
  const tshirtVariantIds = selectBlackTshirtVariants(selectedTshirt.variants).map((variant) => variant.id);
  const verifiedAt = new Date().toISOString();

  const reportLines = [
    "STICKER PRODUCTS:",
    ...stickerDetails.flatMap(({ product, variants }) => renderProductBlock(product, variants)),
    "",
    "T-SHIRT PRODUCTS:",
    ...tshirtDetails.flatMap(({ product, variants }) => renderProductBlock(product, variants)),
    "",
    `Selected sticker blueprint: ${selectedSticker.product.id}`,
    `Selected sticker variants: ${stickerVariantIds.join(", ")}`,
    `Selected t-shirt blueprint: ${selectedTshirt.product.id}`,
    `Selected t-shirt variants: ${tshirtVariantIds.join(", ")}`,
  ];

  const cache: CatalogCacheFile = {
    sticker: {
      blueprint_id: selectedSticker.product.id,
      variant_ids: stickerVariantIds,
      verified_at: verifiedAt,
    },
    "t-shirt": {
      blueprint_id: selectedTshirt.product.id,
      variant_ids: tshirtVariantIds,
      verified_at: verifiedAt,
    },
  };

  await mkdir(resolveProjectPath("data"), { recursive: true });
  await writeFile(reportPath, `${reportLines.join("\n")}\n`, "utf8");
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  logger.action("Verified Printful catalog", "success", {
    reportPath,
    cachePath,
    stickerBlueprintId: cache.sticker.blueprint_id,
    tshirtBlueprintId: cache["t-shirt"].blueprint_id,
  });

  return cache;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  try {
    const cache = await runVerifyPrintfulCatalog();
    console.log(`STICKER blueprint: ${cache.sticker.blueprint_id}`);
    console.log(`STICKER variants: ${cache.sticker.variant_ids.join(", ")}`);
    console.log(`T-SHIRT blueprint: ${cache["t-shirt"].blueprint_id}`);
    console.log(`T-SHIRT variants: ${cache["t-shirt"].variant_ids.join(", ")}`);
    console.log(`Report saved to ${reportPath}`);
    console.log(`Cache saved to ${cachePath}`);
  } catch (error) {
    logger.error("Standalone verify-printful-catalog execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
