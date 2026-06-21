export type CredentialStatus = "PRESENT_VALID" | "PRESENT_SUSPECT" | "BLANK" | "MISSING";

export interface CredentialManifestEntry {
  provider: string;
  key: string;
  required: boolean;
  features: string[];
  acquisitionUrl: string;
  formatDescription: string;
  note?: string;
  validate: (value: string) => boolean;
  secretLike?: boolean;
}

export interface CredentialEvaluation {
  entry: CredentialManifestEntry;
  status: CredentialStatus;
  formatCheck: string;
  displayStatus: string;
}

const suspiciousFragments = ["your_", "_here", "xxx", "placeholder", "test", "todo", "fixme"];

/**
 * Tests whether a string looks obviously placeholder-like even if it is non-empty.
 */
function isSuspiciousValue(value: string, entry: CredentialManifestEntry): boolean {
  const normalized = value.trim().toLowerCase();
  if (suspiciousFragments.some((fragment) => normalized.includes(fragment))) {
    return true;
  }

  if (entry.secretLike && normalized.length < 8) {
    return true;
  }

  return false;
}

/**
 * Returns a redacted preview that is safe to print when a value looks malformed or placeholder-like.
 */
function redactPreview(value: string): string {
  return `${value.slice(0, 4)}...`;
}

/**
 * Creates a manifest entry with the repetitive fields kept compact at the callsite.
 */
function entry(
  provider: string,
  key: string,
  required: boolean,
  formatDescription: string,
  acquisitionUrl: string,
  features: string[],
  validate: (value: string) => boolean,
  secretLike = false,
  note?: string,
): CredentialManifestEntry {
  return {
    provider,
    key,
    required,
    formatDescription,
    acquisitionUrl,
    features,
    validate,
    secretLike,
    note,
  };
}

/**
 * Shared manifest of all credentials and config values Jarvis expects across providers and local runtime config.
 */
export const credentialManifest: CredentialManifestEntry[] = [
  entry(
    "Anthropic",
    "ANTHROPIC_API_KEY",
    true,
    "prefix sk-ant-",
    "https://console.anthropic.com/settings/keys",
    ["listing-gen", "marketing-engine", "trademark-hunter", "llm-router", "customer service drafting"],
    (value) => value.startsWith("sk-ant-"),
    true,
  ),
  entry(
    "OpenAI",
    "OPENAI_API_KEY",
    true,
    "prefix sk-",
    "https://platform.openai.com/api-keys",
    ["llm-router fallback", "design-generator fallback", "mockup generation", "SEO fallback"],
    (value) => value.startsWith("sk-"),
    true,
  ),
  entry(
    "Replicate",
    "REPLICATE_API_TOKEN",
    true,
    "prefix r8_",
    "https://replicate.com/account/api-tokens",
    ["image-gen", "design-generator fallback", "bulk variant generation"],
    (value) => value.startsWith("r8_"),
    true,
  ),
  entry(
    "Etsy",
    "ETSY_API_KEY",
    true,
    "24+ alphanumeric",
    "https://developers.etsy.com/",
    ["etsy-research", "etsy-publish", "etsy-analytics", "order-orchestrator", "trend-miner"],
    (value) => /^[a-z0-9]{24,}$/i.test(value),
    true,
  ),
  entry(
    "Etsy",
    "ETSY_API_SECRET",
    true,
    "10+ alphanumeric",
    "https://developers.etsy.com/",
    ["etsy-research", "etsy-publish", "etsy-analytics", "order-orchestrator", "trend-miner"],
    (value) => /^[a-z0-9]{10,}$/i.test(value),
    true,
  ),
  entry(
    "Etsy",
    "ETSY_ACCESS_TOKEN",
    true,
    "post-OAuth token",
    "https://developers.etsy.com/documentation/essentials/authentication/",
    ["etsy-research", "etsy-publish", "etsy-analytics", "order-orchestrator", "trend-miner"],
    (value) => value.length >= 16,
    true,
  ),
  entry(
    "Etsy",
    "ETSY_REFRESH_TOKEN",
    true,
    "post-OAuth token",
    "https://developers.etsy.com/documentation/essentials/authentication/",
    ["automatic Etsy token refresh", "etsy-research", "etsy-publish", "etsy-analytics", "order-orchestrator"],
    (value) => value.length >= 16,
    true,
  ),
  entry(
    "Etsy",
    "ETSY_USER_ID",
    true,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/shopmanagement/",
    ["etsy account-specific user routing", "fetch_etsy_defaults", "oauth validation"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Etsy",
    "ETSY_SHOP_ID",
    true,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/shopmanagement/",
    ["etsy-publish", "etsy-analytics", "order-orchestrator"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Etsy",
    "ETSY_DEFAULT_TAXONOMY_ID",
    true,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/listings/",
    ["etsy-publish", "listing taxonomy fallback"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Etsy",
    "ETSY_SHIPPING_PROFILE_ID",
    true,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/listings/",
    ["etsy-publish for physical listings"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Etsy",
    "ETSY_READINESS_STATE_ID",
    true,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/listings/",
    ["etsy-publish for physical listings"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Etsy",
    "ETSY_DEFAULT_SHOP_SECTION_ID",
    false,
    "numeric",
    "https://developers.etsy.com/documentation/tutorials/shopmanagement/",
    ["optional default shop section assignment"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Printify",
    "PRINTIFY_API_TOKEN",
    true,
    "long JWT-like token",
    "https://printify.com/app/account/api",
    ["pod-publisher", "order-orchestrator", "POD catalog sync"],
    (value) => value.split(".").length >= 2 || value.length >= 24,
    true,
  ),
  entry(
    "Printify",
    "PRINTIFY_SHOP_ID",
    true,
    "numeric",
    "https://developers.printify.com/",
    ["pod-publisher", "order-orchestrator"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "Printful",
    "PRINTFUL_API_TOKEN",
    false,
    "alphanumeric",
    "https://developers.printful.com/login",
    ["Printful backup publishing", "Printful backup fulfillment"],
    (value) => /^[a-z0-9._-]{8,}$/i.test(value),
    true,
  ),
  entry(
    "imgbb",
    "IMGBB_API_KEY",
    true,
    "alphanumeric API key from api.imgbb.com",
    "https://api.imgbb.com/",
    ["POD image upload pipeline", "Printful file hosting handoff"],
    (value) => /^[a-z0-9]+$/i.test(value),
    true,
  ),
  entry(
    "Ideogram",
    "IDEOGRAM_API_KEY",
    false,
    "non-empty API key",
    "https://ideogram.ai/manage-api",
    ["design-generator primary apparel text rendering"],
    (value) => value.length >= 8,
    true,
  ),
  entry(
    "Recraft",
    "RECRAFT_API_KEY",
    false,
    "non-empty API key",
    "https://www.recraft.ai/",
    ["design-generator vector/logo routing"],
    (value) => value.length >= 8,
    true,
  ),
  entry(
    "Pinterest",
    "PINTEREST_ACCESS_TOKEN",
    false,
    "prefix pina_",
    "https://developers.pinterest.com/apps/",
    ["marketing-engine Pinterest publishing"],
    (value) => value.startsWith("pina_"),
    true,
  ),
  entry(
    "Pinterest",
    "PINTEREST_BOARD_ID",
    false,
    "numeric",
    "https://developers.pinterest.com/apps/",
    ["marketing-engine Pinterest scheduling target"],
    (value) => /^\d+$/.test(value),
  ),
  entry(
    "YouTube",
    "YOUTUBE_API_KEY",
    false,
    "Google API key",
    "https://console.cloud.google.com/apis/credentials",
    ["trend-miner YouTube source"],
    (value) => value.length >= 8,
    true,
  ),
  entry(
    "Spotify",
    "SPOTIFY_CLIENT_ID",
    false,
    "Spotify app client id",
    "https://developer.spotify.com/dashboard",
    ["trend-miner Spotify source"],
    (value) => value.length >= 8,
    true,
  ),
  entry(
    "Spotify",
    "SPOTIFY_CLIENT_SECRET",
    false,
    "Spotify app client secret",
    "https://developer.spotify.com/dashboard",
    ["trend-miner Spotify source"],
    (value) => value.length >= 8,
    true,
  ),
  entry(
    "Reddit",
    "REDDIT_CLIENT_ID",
    false,
    "14-char",
    "https://support.reddithelp.com/hc/en-us/articles/26410290525844-Reddit-s-Responsible-Builder-Policy",
    ["trend-miner legacy Reddit source", "trademark-hunter cultural relevance"],
    (value) => value.length === 14,
    true,
    "Reddit requires commercial approval - see Responsible Builder Policy.",
  ),
  entry(
    "Reddit",
    "REDDIT_CLIENT_SECRET",
    false,
    "27-char",
    "https://support.reddithelp.com/hc/en-us/articles/26410290525844-Reddit-s-Responsible-Builder-Policy",
    ["trend-miner legacy Reddit source", "trademark-hunter cultural relevance"],
    (value) => value.length === 27,
    true,
    "Reddit requires commercial approval - see Responsible Builder Policy.",
  ),
  entry(
    "Reddit",
    "REDDIT_USER_AGENT",
    false,
    "string",
    "https://support.reddithelp.com/hc/en-us/articles/26410290525844-Reddit-s-Responsible-Builder-Policy",
    ["trend-miner legacy Reddit source", "trademark-hunter Reddit requests"],
    (value) => value.length >= 3,
    false,
    "Reddit requires commercial approval - see Responsible Builder Policy.",
  ),
  entry(
    "USPTO",
    "USPTO_API_KEY",
    true,
    "alphanumeric key, usually around 40 chars",
    "https://developer.uspto.gov/api-catalog/tsdr-data-api",
    ["trademark-hunter", "USPTO smoke probe"],
    (value) => /^[a-z0-9]{24,64}$/i.test(value),
    true,
  ),
  entry(
    "USPTO",
    "USPTO_TSDR_ENDPOINT",
    true,
    "prefix https://",
    "https://developer.uspto.gov/api-catalog/tsdr-data-api",
    ["trademark-hunter"],
    (value) => value.startsWith("https://"),
  ),
  entry(
    "Discord",
    "DISCORD_WEBHOOK_URL",
    true,
    "prefix https://discord.com/api/webhooks/",
    "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    ["etsy-analytics", "trademark-hunter alerts", "smoke-test reporting"],
    (value) => value.startsWith("https://discord.com/api/webhooks/"),
    true,
  ),
  entry(
    "Config",
    "DB_PATH",
    true,
    "prefix ./",
    "https://github.com/motdotla/dotenv#readme",
    ["database initialization", "all skills that persist local state"],
    (value) => value.startsWith("./"),
  ),
  entry(
    "Config",
    "LOG_LEVEL",
    true,
    "string",
    "https://github.com/motdotla/dotenv#readme",
    ["structured logging", "operator debugging"],
    (value) => value.length >= 3,
  ),
  entry(
    "Config",
    "DRY_RUN",
    true,
    "true|false",
    "https://github.com/motdotla/dotenv#readme",
    ["smoke-test safe execution", "non-destructive validation"],
    (value) => value === "true" || value === "false",
  ),
  entry(
    "Config",
    "REDDIT_ENABLED",
    false,
    "true|false",
    "https://support.reddithelp.com/hc/en-us/articles/26410290525844-Reddit-s-Responsible-Builder-Policy",
    ["optional Reddit source enablement"],
    (value) => value === "true" || value === "false",
  ),
  entry(
    "Config",
    "DAILY_DESIGN_BUDGET_USD",
    true,
    "number",
    "https://github.com/motdotla/dotenv#readme",
    ["design-generator budget safety rail"],
    (value) => Number.isFinite(Number(value)),
  ),
  entry(
    "Config",
    "WEEKLY_AD_BUDGET_USD",
    true,
    "number",
    "https://github.com/motdotla/dotenv#readme",
    ["marketing-engine budget safety rail"],
    (value) => Number.isFinite(Number(value)),
  ),
  entry(
    "Config",
    "TRADEMARK_REVIEW_THRESHOLD",
    true,
    "0-1",
    "https://github.com/motdotla/dotenv#readme",
    ["trademark-hunter alert threshold"],
    (value) => {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) && numericValue >= 0 && numericValue <= 1;
    },
  ),
  entry(
    "Config",
    "MAX_LISTINGS_PER_RUN",
    true,
    "number",
    "https://github.com/motdotla/dotenv#readme",
    ["jarvis-loop publish caps"],
    (value) => Number.isFinite(Number(value)),
  ),
  entry(
    "Config",
    "LLM_ROUTING_STRATEGY",
    true,
    "cost_optimized|quality_first|speed_first",
    "https://github.com/motdotla/dotenv#readme",
    ["llm-router model selection"],
    (value) => value === "cost_optimized" || value === "quality_first" || value === "speed_first",
  ),
];

/**
 * Groups the manifest by provider while preserving the authored entry order.
 */
export function groupManifestByProvider(): Map<string, CredentialManifestEntry[]> {
  const groups = new Map<string, CredentialManifestEntry[]>();
  for (const item of credentialManifest) {
    const group = groups.get(item.provider) ?? [];
    group.push(item);
    groups.set(item.provider, group);
  }
  return groups;
}

/**
 * Evaluates one manifest entry against the parsed .env contents without exposing the raw secret value.
 */
export function evaluateCredentialEntry(
  parsedEnv: Record<string, string | undefined>,
  item: CredentialManifestEntry,
): CredentialEvaluation {
  const noteSuffix = item.note ? `; ${item.note}` : "";

  if (!(item.key in parsedEnv)) {
    return {
      entry: item,
      status: "MISSING",
      formatCheck: "key missing from .env",
      displayStatus: "MISSING",
    };
  }

  const rawValue = parsedEnv[item.key];
  const value = rawValue?.trim() ?? "";
  if (!value) {
    return {
      entry: item,
      status: "BLANK",
      formatCheck: "declared but empty",
      displayStatus: "BLANK",
    };
  }

  if (isSuspiciousValue(value, item)) {
    return {
      entry: item,
      status: "PRESENT_SUSPECT",
      formatCheck: `looks like a placeholder or malformed (${item.formatDescription})${noteSuffix}`,
      displayStatus: `PRESENT_SUSPECT - starts with: ${redactPreview(value)}`,
    };
  }

  if (!item.validate(value)) {
    return {
      entry: item,
      status: "PRESENT_SUSPECT",
      formatCheck: `failed ${item.formatDescription}${noteSuffix}`,
      displayStatus: `PRESENT_SUSPECT - starts with: ${redactPreview(value)}`,
    };
  }

  return {
    entry: item,
    status: "PRESENT_VALID",
    formatCheck: `matches ${item.formatDescription}${noteSuffix}`,
    displayStatus: "PRESENT_VALID",
  };
}

/**
 * Evaluates every manifest entry against the parsed .env file.
 */
export function evaluateCredentialManifest(
  parsedEnv: Record<string, string | undefined>,
): CredentialEvaluation[] {
  return credentialManifest.map((item) => evaluateCredentialEntry(parsedEnv, item));
}
