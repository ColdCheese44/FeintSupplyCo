import "dotenv/config";

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createLogger } from "./logger.js";

/**
 * Etsy refresh tokens expire 90 days after they are issued. When one lapses, every
 * authenticated call fails with invalid_grant and the whole automation stack goes quiet
 * without raising anything. This module tracks the issue date so the watchdog can warn
 * while there is still time to re-authorize.
 *
 * This exists because the shop lost roughly eight weeks of trading to exactly that failure:
 * listings expired, nothing renewed them, and no alert fired.
 */

export const ETSY_REFRESH_TOKEN_LIFETIME_DAYS = 90;

const WARNING_DAYS_REMAINING = 30;
const CRITICAL_DAYS_REMAINING = 14;
const ISSUED_AT_KEY = "ETSY_REFRESH_TOKEN_ISSUED_AT";

const logger = createLogger("etsy-token-health");

export type EtsyTokenStatus = "healthy" | "warning" | "critical" | "expired" | "unknown";

export interface EtsyTokenHealth {
  issuedAt: string | null;
  ageDays: number | null;
  daysRemaining: number | null;
  status: EtsyTokenStatus;
  message: string;
}

/**
 * Stamps the moment a refresh token was issued, so its age can be measured later.
 * Called whenever a new refresh token is persisted.
 */
export function stampRefreshTokenIssued(issuedAt: Date = new Date()): void {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const value = issuedAt.toISOString();
    const nextLine = `${ISSUED_AT_KEY}=${value}`;
    let content = readFileSync(envPath, "utf-8");

    if (new RegExp(`^${ISSUED_AT_KEY}=.*$`, "m").test(content)) {
      content = content.replace(new RegExp(`^${ISSUED_AT_KEY}=.*$`, "m"), nextLine);
    } else {
      content = `${content.replace(/\s*$/, "")}\n${nextLine}\n`;
    }

    writeFileSync(envPath, content, "utf-8");
    process.env[ISSUED_AT_KEY] = value;
    logger.action("Recorded Etsy refresh token issue date", "success", { issuedAt: value });
  } catch (error) {
    // Never let bookkeeping break an otherwise successful token refresh.
    logger.warn("Could not record Etsy refresh token issue date", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reports how much life the stored Etsy refresh token has left.
 */
export function getEtsyTokenHealth(): EtsyTokenHealth {
  const raw = process.env[ISSUED_AT_KEY]?.trim();

  if (!raw) {
    return {
      issuedAt: null,
      ageDays: null,
      daysRemaining: null,
      status: "unknown",
      message: `${ISSUED_AT_KEY} is not set, so refresh token age cannot be checked. Run npm run etsy:oauth to re-authorize and start tracking.`,
    };
  }

  const issuedAt = new Date(raw);
  if (Number.isNaN(issuedAt.getTime())) {
    return {
      issuedAt: raw,
      ageDays: null,
      daysRemaining: null,
      status: "unknown",
      message: `${ISSUED_AT_KEY} is not a valid date: ${raw}`,
    };
  }

  const ageDays = (Date.now() - issuedAt.getTime()) / (1000 * 60 * 60 * 24);
  const daysRemaining = ETSY_REFRESH_TOKEN_LIFETIME_DAYS - ageDays;
  const rounded = Math.floor(daysRemaining);

  let status: EtsyTokenStatus = "healthy";
  let message = `Etsy refresh token is healthy - about ${rounded} days left.`;

  if (daysRemaining <= 0) {
    status = "expired";
    message = "Etsy refresh token has EXPIRED. Every Etsy API call will fail until you run npm run etsy:oauth.";
  } else if (daysRemaining <= CRITICAL_DAYS_REMAINING) {
    status = "critical";
    message = `Etsy refresh token expires in about ${rounded} days. Run npm run etsy:oauth now to avoid an outage.`;
  } else if (daysRemaining <= WARNING_DAYS_REMAINING) {
    status = "warning";
    message = `Etsy refresh token expires in about ${rounded} days. Plan to run npm run etsy:oauth.`;
  }

  return {
    issuedAt: issuedAt.toISOString(),
    ageDays: Number(ageDays.toFixed(1)),
    daysRemaining: Number(daysRemaining.toFixed(1)),
    status,
    message,
  };
}
