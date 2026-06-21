import "dotenv/config";

import { createLogger } from "./logger.js";

const logger = createLogger("discord");

/**
 * Logical Discord destinations. Each maps to a per-channel webhook env var and falls back to the
 * shared DISCORD_WEBHOOK_URL when that channel has no dedicated webhook configured.
 */
export type DiscordChannel =
  | "default"
  | "heartbeat"
  | "analytics"
  | "orders"
  | "cost"
  | "watchdog"
  | "igm"
  | "legal";

const channelEnvVar: Record<Exclude<DiscordChannel, "default">, string> = {
  heartbeat: "DISCORD_HEARTBEAT_WEBHOOK_URL",
  analytics: "DISCORD_ANALYTICS_WEBHOOK_URL",
  orders: "DISCORD_ORDERS_WEBHOOK_URL",
  cost: "DISCORD_COST_WEBHOOK_URL",
  watchdog: "DISCORD_WATCHDOG_WEBHOOK_URL",
  igm: "DISCORD_IGM_WEBHOOK_URL",
  legal: "DISCORD_LEGAL_WEBHOOK_URL",
};

/**
 * Returns the bot display name and optional avatar used on every webhook post.
 *
 * The webhook's name configured in Discord's UI is ignored because the payload `username` overrides it,
 * so the bot name is controlled here via DISCORD_BOT_NAME (defaults to "Jarvis").
 */
export function getBotIdentity(): { username: string; avatar_url?: string } {
  const username = process.env.DISCORD_BOT_NAME?.trim() || "Jarvis";
  const avatarUrl = process.env.DISCORD_BOT_AVATAR_URL?.trim();
  return avatarUrl ? { username, avatar_url: avatarUrl } : { username };
}

/**
 * Returns the shared default webhook (the command-post fallback) when configured.
 */
export function getDefaultWebhook(): string | null {
  return process.env.DISCORD_WEBHOOK_URL?.trim() || null;
}

/**
 * Resolves the webhook URL for a channel, falling back to DISCORD_WEBHOOK_URL when the
 * channel-specific webhook is blank. This lets operators split feeds one channel at a time.
 */
export function resolveChannelWebhook(channel: DiscordChannel): string | null {
  if (channel !== "default") {
    const specific = process.env[channelEnvVar[channel]]?.trim();
    if (specific) {
      return specific;
    }
  }
  return getDefaultWebhook();
}

/**
 * Posts a payload to a channel's webhook (or the shared fallback).
 *
 * Never throws: returns false when no webhook is configured or the request fails, so Discord
 * delivery problems can never break the autonomous pipeline. The "Jarvis" username is applied
 * by default but can be overridden by the payload.
 */
export async function postDiscord(channel: DiscordChannel, payload: Record<string, unknown>): Promise<boolean> {
  const webhookUrl = resolveChannelWebhook(channel);
  if (!webhookUrl) {
    logger.action("Discord post skipped; no webhook configured", "skip", { channel });
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Identity is applied last so DISCORD_BOT_NAME always wins over any username baked into a payload.
      body: JSON.stringify({ ...payload, ...getBotIdentity() }),
    });

    if (!response.ok) {
      logger.warn("Discord webhook post failed", {
        channel,
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn("Discord webhook request error", {
      channel,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Convenience wrapper for plain-text posts to a channel.
 */
export async function postDiscordText(channel: DiscordChannel, content: string): Promise<boolean> {
  return postDiscord(channel, { content });
}
