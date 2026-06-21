import "dotenv/config";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("igm-client");

export type IgmStatusCode = "running" | "partial" | "stopped" | "not_installed" | "error";
export type IgmControlAction = "up" | "down" | "restart";

export interface IgmContainer {
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface IgmStatus {
  /** Whether the IGM integration is enabled and Docker is usable. */
  available: boolean;
  dockerAvailable: boolean;
  status: IgmStatusCode;
  runningApps: number;
  totalApps: number;
  containers: IgmContainer[];
  reportedEarningsUsd: number | null;
  currency: string;
  notes: string[];
}

export interface IgmControlResult {
  ok: boolean;
  action: IgmControlAction;
  affected: string[];
  message: string;
}

interface IgmConfig {
  enabled: boolean;
  dockerBin: string;
  containerFilter: RegExp;
  reportedEarningsUsd: number | null;
  currency: string;
  upCommand: string | null;
  downCommand: string | null;
  restartCommand: string | null;
}

/**
 * Default container name/image keywords that identify income-generating apps orchestrated by IGM.
 */
const DEFAULT_CONTAINER_KEYWORDS = [
  "earnapp",
  "honeygain",
  "peer2profit",
  "pawns",
  "iproyal",
  "traffmonetizer",
  "proxyrack",
  "proxylite",
  "packetstream",
  "repocket",
  "earnfm",
  "grass",
  "mysterium",
  "bitping",
  "castar",
  "gaganode",
  "spexip",
  "wipter",
  "uproxy",
  "income",
  "igm",
];

/**
 * Reads IGM integration configuration from the environment with safe project defaults.
 */
export function getIgmConfig(): IgmConfig {
  const rawFilter = process.env.IGM_CONTAINER_FILTER?.trim();
  const containerFilter = rawFilter
    ? new RegExp(rawFilter, "i")
    : new RegExp(`(${DEFAULT_CONTAINER_KEYWORDS.join("|")})`, "i");

  const rawEarnings = process.env.IGM_REPORTED_EARNINGS_USD?.trim();
  const parsedEarnings = rawEarnings ? Number(rawEarnings) : Number.NaN;

  return {
    enabled: ["true", "1", "yes"].includes(process.env.IGM_ENABLED?.trim().toLowerCase() ?? ""),
    dockerBin: process.env.IGM_DOCKER_BIN?.trim() || "docker",
    containerFilter,
    reportedEarningsUsd: Number.isFinite(parsedEarnings) ? parsedEarnings : null,
    currency: process.env.IGM_CURRENCY?.trim() || "USD",
    upCommand: process.env.IGM_UP_COMMAND?.trim() || null,
    downCommand: process.env.IGM_DOWN_COMMAND?.trim() || null,
    restartCommand: process.env.IGM_RESTART_COMMAND?.trim() || null,
  };
}

/**
 * Runs a command and returns its captured output without throwing on a non-zero exit.
 */
async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), missing: false };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const missing = err.code === "ENOENT";
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message ?? "",
      missing,
    };
  }
}

/**
 * Returns whether a usable Docker runtime is reachable on this machine.
 */
export async function isDockerAvailable(): Promise<boolean> {
  const config = getIgmConfig();
  const result = await runCommand(config.dockerBin, ["info", "--format", "{{.ServerVersion}}"], 12000);
  return result.ok && result.stdout.trim().length > 0;
}

/**
 * Lists every Docker container whose name or image matches the configured IGM filter.
 */
async function listIgmContainers(config: IgmConfig): Promise<IgmContainer[]> {
  const result = await runCommand(
    config.dockerBin,
    ["ps", "-a", "--no-trunc", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}"],
    12000,
  );

  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", image = "", state = "", status = ""] = line.split("\t");
      return { name, image, state, status };
    })
    .filter((container) => config.containerFilter.test(container.name) || config.containerFilter.test(container.image));
}

/**
 * Collects a structured IGM status snapshot, degrading gracefully when Docker or IGM is not installed.
 */
export async function getIgmStatus(): Promise<IgmStatus> {
  const config = getIgmConfig();
  const baseline: IgmStatus = {
    available: false,
    dockerAvailable: false,
    status: "not_installed",
    runningApps: 0,
    totalApps: 0,
    containers: [],
    reportedEarningsUsd: config.reportedEarningsUsd,
    currency: config.currency,
    notes: [],
  };

  if (!config.enabled) {
    baseline.notes.push("IGM integration is disabled. Set IGM_ENABLED=true in .env to activate it.");
    return baseline;
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    baseline.notes.push("Docker runtime not detected. Install Docker (and run the IGM bootstrap) to start earning apps.");
    return baseline;
  }

  const containers = await listIgmContainers(config);
  const runningApps = containers.filter((container) => container.state.toLowerCase() === "running").length;
  const totalApps = containers.length;

  let status: IgmStatusCode;
  const notes: string[] = [];
  if (totalApps === 0) {
    status = "stopped";
    notes.push("Docker is running but no IGM containers were found. Run the IGM bootstrap to install earning apps.");
  } else if (runningApps === 0) {
    status = "stopped";
    notes.push("IGM containers exist but none are running. Use `npm run igm:up` to start them.");
  } else if (runningApps < totalApps) {
    status = "partial";
    notes.push(`${totalApps - runningApps} of ${totalApps} IGM containers are not running.`);
  } else {
    status = "running";
  }

  if (config.reportedEarningsUsd == null) {
    notes.push("No earnings figure recorded. Set IGM_REPORTED_EARNINGS_USD or pass --earnings to track income.");
  }

  return {
    available: true,
    dockerAvailable: true,
    status,
    runningApps,
    totalApps,
    containers,
    reportedEarningsUsd: config.reportedEarningsUsd,
    currency: config.currency,
    notes,
  };
}

/**
 * Splits a shell-style override command string into its executable and argument tokens.
 */
function parseOverrideCommand(command: string): { bin: string; args: string[] } {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
  return { bin: cleaned[0] ?? "", args: cleaned.slice(1) };
}

/**
 * Starts, stops, or restarts the IGM earning containers (or runs the configured override command).
 */
export async function controlIgm(action: IgmControlAction): Promise<IgmControlResult> {
  const config = getIgmConfig();

  if (!config.enabled) {
    return { ok: false, action, affected: [], message: "IGM integration is disabled (set IGM_ENABLED=true)." };
  }

  const override = action === "up" ? config.upCommand : action === "down" ? config.downCommand : config.restartCommand;
  if (override) {
    const { bin, args } = parseOverrideCommand(override);
    if (!bin) {
      return { ok: false, action, affected: [], message: `Invalid IGM ${action} override command.` };
    }
    const result = await runCommand(bin, args, 120000);
    const message = result.ok ? `Ran IGM ${action} override command.` : `IGM ${action} override failed: ${result.stderr.trim()}`;
    logger.action(message, result.ok ? "success" : "fail", { action, override });
    return { ok: result.ok, action, affected: [], message };
  }

  if (!(await isDockerAvailable())) {
    return { ok: false, action, affected: [], message: "Docker runtime not detected." };
  }

  const containers = await listIgmContainers(config);
  const targets = action === "up"
    ? containers.filter((container) => container.state.toLowerCase() !== "running")
    : action === "down"
      ? containers.filter((container) => container.state.toLowerCase() === "running")
      : containers;

  if (containers.length === 0) {
    return { ok: false, action, affected: [], message: "No IGM containers found. Run the IGM bootstrap first." };
  }
  if (targets.length === 0) {
    return { ok: true, action, affected: [], message: `No containers needed ${action}; already in the desired state.` };
  }

  const dockerVerb = action === "up" ? "start" : action === "down" ? "stop" : "restart";
  const names = targets.map((container) => container.name);
  const result = await runCommand(config.dockerBin, [dockerVerb, ...names], 120000);
  const message = result.ok
    ? `Docker ${dockerVerb} succeeded for ${names.length} IGM container(s).`
    : `Docker ${dockerVerb} failed: ${result.stderr.trim()}`;
  logger.action(message, result.ok ? "success" : "fail", { action, names });
  return { ok: result.ok, action, affected: names, message };
}
