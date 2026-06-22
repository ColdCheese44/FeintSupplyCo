export const ALL_PRODUCT_TYPES = [
  "sticker",
  "t-shirt",
  "mug",
  "poster",
  "hoodie",
  "hat",
  "enamel-pin",
] as const;

export const HEARTBEAT_ROTATION_PRODUCT_TYPES = [
  "sticker",
  "t-shirt",
  "mug",
  "poster",
  "hoodie",
  "hat",
] as const;

export type ProductType = typeof ALL_PRODUCT_TYPES[number];

export const PRODUCT_BASE_PRICES: Record<ProductType, number> = {
  sticker: 4.99,
  "t-shirt": 29.99,
  mug: 19.99,
  poster: 24.99,
  hoodie: 49.99,
  hat: 26.99,
  "enamel-pin": 14.99,
};

export const PRODUCT_DISPLAY_NAMES: Record<ProductType, string> = {
  sticker: "sticker",
  "t-shirt": "t-shirt",
  mug: "mug",
  poster: "poster",
  hoodie: "hoodie",
  hat: "embroidered hat",
  "enamel-pin": "enamel pin",
};

export const ENAMEL_PIN_FULFILLMENT_NOTE =
  "Made to order. This listing uses a digital mockup preview, and the physical enamel pin is fulfilled manually after purchase.";

/**
 * Normalizes user, seed, and DB product-type strings into the canonical product labels used across FeintSupplyCo.
 */
export function normalizeProductType(value: string | null | undefined): ProductType | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, "-") ?? "";
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "sticker":
    case "stickers":
      return "sticker";
    case "t-shirt":
    case "tshirts":
    case "tshirt":
    case "tee":
    case "tees":
    case "shirt":
      return "t-shirt";
    case "mug":
    case "mugs":
      return "mug";
    case "poster":
    case "posters":
    case "wall-art":
      return "poster";
    case "hoodie":
    case "hoodies":
    case "sweatshirt":
      return "hoodie";
    case "hat":
    case "hats":
    case "cap":
    case "caps":
    case "dad-hat":
    case "dad-hats":
    case "ballcap":
    case "baseball-cap":
    case "snapback":
    case "beanie":
      return "hat";
    case "enamel-pin":
    case "enamel-pins":
    case "pin":
    case "pins":
      return "enamel-pin";
    default:
      return null;
  }
}

/**
 * Returns whether a loose value resolves to one of FeintSupplyCo's supported product types.
 */
export function isProductType(value: string | null | undefined): value is ProductType {
  return normalizeProductType(value) !== null;
}

/**
 * Parses a mixed product-type list into canonical labels while preserving order and removing duplicates.
 */
export function normalizeProductTypeList(values: ReadonlyArray<string> | null | undefined): ProductType[] {
  if (!values || values.length === 0) {
    return [...ALL_PRODUCT_TYPES];
  }

  const seen = new Set<ProductType>();
  const normalized: ProductType[] = [];
  for (const value of values) {
    const productType = normalizeProductType(value);
    if (!productType || seen.has(productType)) {
      continue;
    }
    seen.add(productType);
    normalized.push(productType);
  }

  return normalized.length > 0 ? normalized : [...ALL_PRODUCT_TYPES];
}

/**
 * Returns whether the product type can be routed through POD providers automatically.
 */
export function supportsPodFulfillment(productType: string | null | undefined): boolean {
  const normalized = normalizeProductType(productType);
  return normalized !== null && normalized !== "enamel-pin";
}

/**
 * Returns a human-readable label even when the upstream value is missing or non-standard.
 */
export function getProductDisplayName(productType: string | null | undefined): string {
  const normalized = normalizeProductType(productType);
  return normalized ? PRODUCT_DISPLAY_NAMES[normalized] : "product";
}
