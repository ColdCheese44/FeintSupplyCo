import "dotenv/config";

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { parse as parseDotenv } from "dotenv";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");

interface AuditSummary {
  readinessPercent: number;
  validRequiredKeys: number;
  totalRequiredKeys: number;
  rawOutput: string;
}

/**
 * Reads the local .env file into a parsed object without exposing secret values.
 */
function readParsedEnv(): Record<string, string> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Updates one key in .env while preserving unrelated configuration lines.
 */
function writeEnvValue(key: string, value: string): void {
  const existingLines = readFileSync(envPath, "utf8").split(/\r?\n/);
  const replacement = `${key}=${value}`;
  let updated = false;

  const nextLines = existingLines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return replacement;
    }
    return line;
  });

  if (!updated) {
    nextLines.push(replacement);
  }

  writeFileSync(envPath, nextLines.join("\n"), "utf8");
}

/**
 * Executes an interactive child command with inherited stdio so OAuth and Etsy selection flows remain usable.
 */
async function runInteractiveCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: true,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}.`));
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });
}

/**
 * Runs the audit script and extracts the readiness line for machine-readable go-live decisions.
 */
function runAuditAndParse(): AuditSummary {
  const result = spawnSync("npm.cmd", ["run", "audit"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true,
  });

  const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = rawOutput.match(/Jarvis is (\d+)% ready to run live\. (\d+) of (\d+) required keys are valid\./);
  if (!match) {
    throw new Error("Could not parse the readiness line from npm run audit.");
  }

  return {
    readinessPercent: Number(match[1]),
    validRequiredKeys: Number(match[2]),
    totalRequiredKeys: Number(match[3]),
    rawOutput,
  };
}

/**
 * Prompts once for the DRY_RUN switch so go-live remains an intentional operator action.
 */
async function confirmLiveSwitch(): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question("Switch DRY_RUN to false? y/n ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/**
 * Executes the go-live wizard in the hardened order required for the first real Etsy approval.
 */
async function main(): Promise<void> {
  const parsedEnv = readParsedEnv();
  if ((parsedEnv.DRY_RUN ?? "").trim().toLowerCase() !== "true") {
    throw new Error("DRY_RUN is not currently true in .env. Refusing to continue to prevent an accidental re-run.");
  }

  console.log("Running Etsy preflight...");
  await runInteractiveCommand("npm.cmd", ["run", "etsy:preflight"]);

  console.log("Starting Etsy OAuth...");
  await runInteractiveCommand("npm.cmd", ["run", "etsy:oauth"]);

  console.log("Fetching Etsy shop defaults...");
  await runInteractiveCommand("python", ["scripts/fetch_etsy_defaults.py"]);

  console.log("Re-running credential audit...");
  const audit = runAuditAndParse();
  console.log(audit.rawOutput.trim());

  if (audit.readinessPercent < 100) {
    console.log("");
    console.log("Go-live stopped. Remaining required gaps must be filled before Jarvis can switch out of DRY_RUN.");
    process.exitCode = 1;
    return;
  }

  if (!(await confirmLiveSwitch())) {
    console.log("Go-live aborted. DRY_RUN remains true.");
    return;
  }

  writeEnvValue("DRY_RUN", "false");
  console.log("Jarvis is live.");
  console.log("Run npm run heartbeat.");
}

await main();
