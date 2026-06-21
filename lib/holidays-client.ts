import "dotenv/config";

import { createLogger } from "./logger.js";

const logger = createLogger("holidays-client");

export interface HolidayThemeSignal {
  label: string;
  sourceScore: number;
  metadata?: Record<string, unknown>;
}

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
  global: boolean;
  types?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns whether upcoming-holiday seasonal signals are enabled (defaults to on).
 */
function isHolidaySourceEnabled(): boolean {
  return (process.env.HOLIDAYS_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
}

/**
 * Returns the ISO 3166-1 alpha-2 country code used for the public holiday calendar.
 */
function getHolidayCountry(): string {
  return (process.env.HOLIDAYS_COUNTRY_CODE?.trim() || "US").toUpperCase();
}

/**
 * Returns how many days ahead holidays should be considered for seasonal product lead time.
 */
function getHolidayWindowDays(): number {
  const parsed = Number(process.env.HOLIDAYS_WINDOW_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

/**
 * Fetches upcoming public holidays from the keyless Nager.Date API and converts them into weighted theme signals.
 *
 * Holidays closer to today score higher so the autonomous pipeline has lead time to design and publish seasonal
 * products. The seed keywords are accepted for interface symmetry with other trend sources but are not used.
 */
export async function fetchHolidayThemeSignals(_seedKeywords: string[] = [], limit = 8): Promise<HolidayThemeSignal[]> {
  if (!isHolidaySourceEnabled()) {
    throw new Error("Public holidays source disabled via HOLIDAYS_ENABLED.");
  }

  const country = getHolidayCountry();
  const windowDays = getHolidayWindowDays();
  logger.action("Fetching upcoming public holidays", "start", { country, windowDays, limit });

  const response = await fetch(`https://date.nager.at/api/v3/NextPublicHolidays/${encodeURIComponent(country)}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Public holidays request unavailable: ${response.status} ${response.statusText}`);
  }

  const holidays = (await response.json()) as NagerHoliday[];
  const now = Date.now();
  const horizon = now + windowDays * DAY_MS;

  const signals: HolidayThemeSignal[] = [];
  for (const holiday of holidays) {
    const when = new Date(`${holiday.date}T00:00:00Z`).getTime();
    if (!Number.isFinite(when) || when < now || when > horizon) {
      continue;
    }

    const daysUntil = Math.max(0, Math.round((when - now) / DAY_MS));
    // Sooner holidays rank higher (max ~14 today, easing toward ~2 at the window edge).
    const proximityScore = Number(Math.max(2, 14 - (daysUntil / windowDays) * 12).toFixed(2));

    signals.push({
      label: holiday.name.toLowerCase(),
      sourceScore: proximityScore,
      metadata: {
        date: holiday.date,
        daysUntil,
        country,
        localName: holiday.localName,
        types: holiday.types ?? [],
      },
    });
  }

  logger.action("Fetched upcoming public holidays", "success", { count: signals.length });
  return signals.slice(0, limit);
}
