import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveProjectPath } from "./db.js";

const heartbeatStatePath = resolveProjectPath("data/heartbeat-last-run.txt");

/**
 * Returns the canonical heartbeat timestamp file path so watchdog and orchestrators share one source of truth.
 */
export function getHeartbeatStatePath(): string {
  return heartbeatStatePath;
}

/**
 * Persists the latest successful heartbeat timestamp for watchdog monitoring and operator visibility.
 */
export async function writeHeartbeatTimestamp(timestamp = new Date().toISOString()): Promise<string> {
  await mkdir(dirname(heartbeatStatePath), { recursive: true });
  await writeFile(heartbeatStatePath, `${timestamp}\n`, "utf8");
  return timestamp;
}

/**
 * Reads the last successful heartbeat timestamp when present so watchdog checks can measure freshness safely.
 */
export async function readHeartbeatTimestamp(): Promise<string | null> {
  try {
    return (await readFile(heartbeatStatePath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}
