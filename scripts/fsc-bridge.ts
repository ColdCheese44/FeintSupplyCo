import "dotenv/config";

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type BridgeCommand = "status" | "health" | "verify" | "queue" | "approval-summary" | "doctor" | "audit";

interface CommandRun {
  ok: boolean;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | string | null;
}

interface SafetyPosture {
  requireApproval: boolean;
  requireApprovalRaw: string;
  maxListingsPerDay: number | null;
  maxListingsPerDayOk: boolean;
  ready: boolean;
}

interface LocalhostCheck {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  note: string;
}

interface DbSnapshot {
  path: string;
  exists: boolean;
  ok: boolean;
  tables: string[];
  counts: Record<string, number>;
  failedOperations: {
    available: boolean;
    unresolved: number;
    retryable: number;
    recent: Array<{ id: number; operation_type: string; attempts: number; created_at: string; error: string }>;
  };
  providerHealth: {
    available: boolean;
    latest: Array<{ provider: string; status: string; latency_ms: number | null; created_at: string }>;
  };
  approvalQueue: Array<{
    id: number;
    title: string;
    product_type: string | null;
    niche_name: string | null;
    price: number | null;
    quality_score: number | null;
    created_at: string;
  }>;
  heartbeat: {
    available: boolean;
    latest: Record<string, unknown> | null;
  };
  error?: string;
}

interface TaskStatus {
  name: string;
  found: boolean;
  status: string;
  lastRunTime: string | null;
  lastResult: string | null;
  note: string;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(PROJECT_ROOT, process.env.DB_PATH?.trim() || "data/jarvis.db");
const REPORT_PREFIX = "JarvisLocalhostControl-";
const SUPPORTED_COMMANDS: BridgeCommand[] = [
  "status",
  "health",
  "verify",
  "queue",
  "approval-summary",
  "doctor",
  "audit",
];
const DANGEROUS_COMMAND_PATTERN = /\b(publish|approve|approval|backfill|fulfill|fulfillment|test-order|order|live-mutation|mutation|credentials?|tokens?|rotate)\b/i;
const DISCORD_SUMMARY_LIMIT = 1500;

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function markdownEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function redact(value: string): string {
  return value
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'`)]+/gi, "<REDACTED_DISCORD_WEBHOOK>")
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <REDACTED>")
    .replace(/((?:api[_-]?key|token|secret|password|oauth|webhook)[A-Z0-9_ -]*[=:]\s*)["']?[^"',\s}]+["']?/gi, "$1<REDACTED>");
}

function getCleanupRoot(): string {
  return process.env.FSC_CONTROL_CLEANUP_ROOT?.trim()
    || join(homedir(), "OneDrive", "Documents", "Cleanup");
}

function resolveReportRoot(): string {
  const explicit = process.env.FSC_CONTROL_REPORT_DIR?.trim();
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }

  const cleanupRoot = getCleanupRoot();
  mkdirSync(cleanupRoot, { recursive: true });
  const candidates = readdirSync(cleanupRoot)
    .filter((name) => name.startsWith(REPORT_PREFIX))
    .map((name) => join(cleanupRoot, name))
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.localeCompare(a));

  if (candidates[0]) {
    return candidates[0];
  }

  const created = join(cleanupRoot, `${REPORT_PREFIX}${formatTimestamp()}`);
  mkdirSync(created, { recursive: true });
  return created;
}

async function writeReport(command: BridgeCommand | "refused", content: string): Promise<string> {
  const reportRoot = resolveReportRoot();
  await mkdir(reportRoot, { recursive: true });
  const reportPath = join(reportRoot, `feintsupply-${command}-${formatTimestamp()}.md`);
  await writeFile(reportPath, `${content.trimEnd()}\n`, "utf8");
  return reportPath;
}

function buildTable(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(markdownEscape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownEscape).join(" | ")} |`),
  ].join("\n");
}

function readPackageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function getSafetyPosture(): SafetyPosture {
  const requireApprovalRaw = (process.env.REQUIRE_APPROVAL ?? "").trim();
  const requireApproval = requireApprovalRaw.toLowerCase() === "true";
  const parsedMaxListings = Number.parseInt((process.env.MAX_LISTINGS_PER_DAY ?? "").trim(), 10);
  const maxListingsPerDay = Number.isFinite(parsedMaxListings) ? parsedMaxListings : null;
  const maxListingsPerDayOk = maxListingsPerDay !== null && maxListingsPerDay <= 5;

  return {
    requireApproval,
    requireApprovalRaw: requireApprovalRaw ? "<set>" : "<missing>",
    maxListingsPerDay,
    maxListingsPerDayOk,
    ready: requireApproval && maxListingsPerDayOk,
  };
}

async function fetchLocalhost(name: string, url: string): Promise<LocalhostCheck> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3500),
    });
    const latencyMs = Date.now() - started;
    return {
      name,
      url,
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      latencyMs,
      note: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) {
    return new Set();
  }
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function countRows(db: Database.Database, tableName: string, whereClause = ""): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} ${whereClause}`).get() as { count: number };
  return Number(row.count ?? 0);
}

function readDbSnapshot(): DbSnapshot {
  if (!existsSync(DB_PATH)) {
    return {
      path: DB_PATH,
      exists: false,
      ok: false,
      tables: [],
      counts: {},
      failedOperations: { available: false, unresolved: 0, retryable: 0, recent: [] },
      providerHealth: { available: false, latest: [] },
      approvalQueue: [],
      heartbeat: { available: false, latest: null },
      error: "Database file does not exist.",
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const counts: Record<string, number> = {
      listings: countRows(db, "listings"),
      pending_approval: countRows(db, "listings", "WHERE status = 'pending_approval'"),
      published: countRows(db, "listings", "WHERE status = 'published'"),
      designs: countRows(db, "designs"),
      orders: countRows(db, "orders"),
    };

    const failedOperationsAvailable = tableExists(db, "failed_operations");
    const failedOperations = failedOperationsAvailable
      ? {
          available: true,
          unresolved: countRows(db, "failed_operations", "WHERE resolved_at IS NULL"),
          retryable: countRows(db, "failed_operations", "WHERE resolved_at IS NULL AND attempts < 5"),
          recent: (db.prepare(`
            SELECT id, operation_type, attempts, created_at, error
            FROM failed_operations
            WHERE resolved_at IS NULL
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT 5
          `).all() as Array<{ id: number; operation_type: string; attempts: number; created_at: string; error: string }>)
            .map((row) => ({ ...row, error: truncate(redact(row.error), 180) })),
        }
      : { available: false, unresolved: 0, retryable: 0, recent: [] };

    const providerHealthAvailable = tableExists(db, "provider_health");
    const providerColumns = tableColumns(db, "provider_health");
    const providerTimestampExpression = providerColumns.has("created_at")
      ? "created_at"
      : providerColumns.has("checked_at")
        ? "checked_at"
        : "NULL";
    const providerHealth = providerHealthAvailable
      ? {
          available: true,
          latest: db.prepare(`
            SELECT provider, status, latency_ms, created_at
            FROM (
              SELECT provider, status, latency_ms, ${providerTimestampExpression} AS created_at, id
              FROM provider_health
            )
            WHERE id IN (
              SELECT MAX(id)
              FROM provider_health
              GROUP BY provider
            )
            ORDER BY provider COLLATE NOCASE ASC
          `).all() as Array<{ provider: string; status: string; latency_ms: number | null; created_at: string }>,
        }
      : { available: false, latest: [] };

    const approvalQueue = tableExists(db, "listings")
      ? db.prepare(`
          SELECT
            listings.id,
            listings.title,
            listings.product_type,
            listings.price,
            listings.quality_score,
            listings.created_at,
            niches.name AS niche_name
          FROM listings
          LEFT JOIN niches ON niches.id = listings.niche_id
          WHERE listings.status = 'pending_approval'
          ORDER BY datetime(listings.created_at) DESC, listings.id DESC
          LIMIT 25
        `).all() as DbSnapshot["approvalQueue"]
      : [];

    const heartbeatAvailable = tableExists(db, "heartbeat_log");
    const heartbeat = heartbeatAvailable
      ? {
          available: true,
          latest: (db.prepare(`
            SELECT started_at, finished_at, opportunities_considered, designs_generated, listings_published, total_cost_usd, error_count, created_at
            FROM heartbeat_log
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT 1
          `).get() as Record<string, unknown> | undefined) ?? null,
        }
      : { available: false, latest: null };

    return {
      path: DB_PATH,
      exists: true,
      ok: true,
      tables,
      counts,
      failedOperations,
      providerHealth,
      approvalQueue,
      heartbeat,
    };
  } catch (error) {
    return {
      path: DB_PATH,
      exists: true,
      ok: false,
      tables: [],
      counts: {},
      failedOperations: { available: false, unresolved: 0, retryable: 0, recent: [] },
      providerHealth: { available: false, latest: [] },
      approvalQueue: [],
      heartbeat: { available: false, latest: null },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<CommandRun> {
  return new Promise((resolveRun) => {
    const useCmdLauncher = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const spawnCommand = useCmdLauncher ? (process.env.ComSpec || "cmd.exe") : command;
    const spawnArgs = useCmdLauncher ? ["/d", "/s", "/c", command, ...args] : args;
    const options = {
      cwd: PROJECT_ROOT,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    };
    try {
      execFile(spawnCommand, spawnArgs, options, (error, stdout, stderr) => {
        const maybeError = error as NodeJS.ErrnoException | null;
        resolveRun({
          ok: !error,
          command,
          args,
          stdout: redact(stdout.toString()),
          stderr: redact(stderr.toString()),
          exitCode: maybeError?.code ?? null,
        });
      });
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException;
      resolveRun({
        ok: false,
        command,
        args,
        stdout: "",
        stderr: redact(maybeError.stack ?? maybeError.message ?? String(error)),
        exitCode: maybeError?.code ?? null,
      });
    }
  });
}

async function runNpmScript(scriptName: string): Promise<CommandRun> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return runProcess(npmCommand, ["run", scriptName], scriptName === "catalog:verify" ? 240000 : 120000);
}

async function runTypecheck(): Promise<CommandRun> {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  return runProcess(npxCommand, ["tsc", "--noEmit"], 120000);
}

function parseTaskOutput(name: string, run: CommandRun): TaskStatus {
  if (!run.ok) {
    const combined = `${run.stdout}\n${run.stderr}`;
    return {
      name,
      found: false,
      status: "not found",
      lastRunTime: null,
      lastResult: null,
      note: truncate(redact(combined.trim() || "schtasks query failed"), 180),
    };
  }

  const readField = (field: string): string | null => {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = run.stdout.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() ?? null;
  };

  return {
    name,
    found: true,
    status: readField("Status") ?? "unknown",
    lastRunTime: readField("Last Run Time"),
    lastResult: readField("Last Result"),
    note: "read-only schtasks query",
  };
}

async function getScheduledTaskStatuses(): Promise<TaskStatus[]> {
  const candidates = [
    "FEINT SUPPLY CO Heartbeat",
    "FeintSupplyCo Heartbeat",
    "fsc-heartbeat",
    "FEINT SUPPLY CO Order Watch",
    "FeintSupplyCo Order Watch",
    "feintsupply-orderwatch",
    "FeintSupplyCo OrderWatch",
  ];
  const schtasks = process.platform === "win32" ? "schtasks.exe" : "schtasks";
  const results: TaskStatus[] = [];
  for (const name of candidates) {
    const run = await runProcess(schtasks, ["/Query", "/TN", name, "/V", "/FO", "LIST"], 15000);
    const parsed = parseTaskOutput(name, run);
    if (parsed.found) {
      if (results.some((task) => task.name.toLowerCase() === parsed.name.toLowerCase())) {
        continue;
      }
      results.push(parsed);
    }
  }
  if (results.length > 0) {
    return results;
  }
  return [
    {
      name: "FEINT SUPPLY CO heartbeat/order-watch",
      found: false,
      status: "not found",
      lastRunTime: null,
      lastResult: null,
      note: "No known FEINT SUPPLY CO heartbeat/order-watch scheduled task names were found.",
    },
  ];
}

function renderSafetySection(safety: SafetyPosture): string {
  return [
    "## Safety Posture",
    "",
    buildTable(
      ["Check", "Result", "Notes"],
      [
        ["REQUIRE_APPROVAL", safety.requireApproval ? "PASS" : "FAIL", safety.requireApproval ? "true" : `not confirmed (${safety.requireApprovalRaw})`],
        ["MAX_LISTINGS_PER_DAY", safety.maxListingsPerDayOk ? "PASS" : "FAIL", safety.maxListingsPerDay ?? "<missing>"],
        ["Default posture", "PASS", "Bridge commands are read-only unless running build/typecheck/catalog verification."],
        ["Dangerous actions", "BLOCKED", "publish, approve, backfill, fulfill, test-order, live mutations, credential changes"],
        ["Secrets", "REDACTED", "Bridge does not print .env values, tokens, API keys, OAuth secrets, or webhook URLs."],
      ],
    ),
  ].join("\n");
}

function renderLocalhostSection(checks: LocalhostCheck[]): string {
  return [
    "## Localhost Surfaces",
    "",
    buildTable(
      ["Surface", "URL", "Result", "HTTP", "Latency", "Notes"],
      checks.map((check) => [
        check.name,
        check.url,
        check.ok ? "PASS" : "WARN",
        check.status ?? "-",
        check.latencyMs === null ? "-" : `${check.latencyMs}ms`,
        check.note,
      ]),
    ),
  ].join("\n");
}

function renderDbSection(db: DbSnapshot): string {
  const lines = [
    "## Database",
    "",
    buildTable(
      ["Check", "Result", "Notes"],
      [
        ["Path", db.exists ? "FOUND" : "MISSING", db.path],
        ["Open read-only", db.ok ? "PASS" : "FAIL", db.error ?? "opened with better-sqlite3 readonly mode"],
        ["Listings", db.ok ? String(db.counts.listings ?? 0) : "-", "total tracked"],
        ["Pending approvals", db.ok ? String(db.counts.pending_approval ?? 0) : "-", "no approvals performed"],
        ["Published listings", db.ok ? String(db.counts.published ?? 0) : "-", "read-only count"],
        ["Failed operations", db.failedOperations.available ? String(db.failedOperations.unresolved) : "unavailable", "unresolved rows"],
      ],
    ),
  ];

  if (db.failedOperations.recent.length > 0) {
    lines.push("", "### Recent Failed Operations", "", buildTable(
      ["ID", "Type", "Attempts", "Created", "Error Preview"],
      db.failedOperations.recent.map((row) => [row.id, row.operation_type, row.attempts, row.created_at, row.error]),
    ));
  }

  return lines.join("\n");
}

function renderProviderHealthSection(db: DbSnapshot): string {
  if (!db.providerHealth.available) {
    return "## Provider Health\n\nProvider health table is not available yet.";
  }
  if (db.providerHealth.latest.length === 0) {
    return "## Provider Health\n\nProvider health table exists, but no provider snapshots have been recorded yet.";
  }
  return [
    "## Provider Health",
    "",
    buildTable(
      ["Provider", "Status", "Latency", "Created"],
      db.providerHealth.latest.map((row) => [
        row.provider,
        row.status,
        row.latency_ms === null ? "-" : `${row.latency_ms}ms`,
        row.created_at,
      ]),
    ),
  ].join("\n");
}

function renderTaskSection(tasks: TaskStatus[]): string {
  return [
    "## Scheduled Tasks",
    "",
    buildTable(
      ["Task", "Found", "Status", "Last Run", "Last Result", "Notes"],
      tasks.map((task) => [task.name, task.found ? "yes" : "no", task.status, task.lastRunTime ?? "-", task.lastResult ?? "-", task.note]),
    ),
  ].join("\n");
}

function renderQueueSection(db: DbSnapshot, title = "Approval Queue"): string {
  const byProductType = new Map<string, number>();
  for (const row of db.approvalQueue) {
    const key = row.product_type || "unknown";
    byProductType.set(key, (byProductType.get(key) ?? 0) + 1);
  }

  const lines = [
    `## ${title}`,
    "",
    `Pending approval count: ${db.counts.pending_approval ?? 0}`,
    "",
  ];

  if (byProductType.size > 0) {
    lines.push(buildTable(
      ["Product Type", "Count"],
      [...byProductType.entries()].sort((a, b) => b[1] - a[1]),
    ), "");
  }

  if (db.approvalQueue.length === 0) {
    lines.push("No pending approval rows were found. No dashboard items were approved or modified.");
  } else {
    lines.push(buildTable(
      ["ID", "Title", "Product Type", "Niche", "Price", "Quality", "Created"],
      db.approvalQueue.map((row) => [
        row.id,
        truncate(row.title, 72),
        row.product_type ?? "unknown",
        row.niche_name ?? "unassigned",
        row.price ?? "-",
        row.quality_score ?? "-",
        row.created_at,
      ]),
    ));
    lines.push("", "No dashboard items were approved or modified.");
  }

  return lines.join("\n");
}

async function collectStatusInputs(): Promise<{
  safety: SafetyPosture;
  localhost: LocalhostCheck[];
  db: DbSnapshot;
}> {
  const safety = getSafetyPosture();
  const [openClaw, dashboard] = await Promise.all([
    fetchLocalhost("OpenClaw Control UI", "http://127.0.0.1:18789/"),
    fetchLocalhost("FEINT SUPPLY CO Dashboard", "http://localhost:4200/"),
  ]);
  const db = readDbSnapshot();
  return { safety, localhost: [openClaw, dashboard], db };
}

function commandSummary(status: "PASS" | "WARN" | "FAIL", lines: string[], reportPath: string, nextCommand: string): void {
  const summary = [`FEINT SUPPLY CO bridge: ${status}`, ...lines].join("\n");
  console.log(truncate(summary, DISCORD_SUMMARY_LIMIT));
  console.log(`Report: ${reportPath}`);
  console.log(`Next safe command: ${nextCommand}`);
}

async function runStatus(): Promise<boolean> {
  const { safety, localhost, db } = await collectStatusInputs();
  const ready = safety.ready && db.ok && localhost.every((check) => check.ok);
  const report = [
    "# FEINT SUPPLY CO Localhost Status",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(safety),
    "",
    renderLocalhostSection(localhost),
    "",
    renderDbSection(db),
  ].join("\n");
  const reportPath = await writeReport("status", report);
  commandSummary(ready ? "PASS" : "WARN", [
    `ready=${ready}`,
    `approval=${safety.requireApproval ? "true" : "NOT CONFIRMED"}`,
    `maxListingsPerDay=${safety.maxListingsPerDay ?? "missing"}`,
    `dashboard=${localhost.find((check) => check.name === "FEINT SUPPLY CO Dashboard")?.note ?? "unknown"}`,
    `db=${db.ok ? "ok" : "not ok"}`,
    `failedOps=${db.failedOperations.available ? db.failedOperations.unresolved : "unavailable"}`,
  ], reportPath, "npm run fsc:health");
  return safety.ready;
}

async function runHealth(): Promise<boolean> {
  const { safety, localhost, db } = await collectStatusInputs();
  const tasks = await getScheduledTaskStatuses();
  const report = [
    "# FEINT SUPPLY CO Localhost Health",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(safety),
    "",
    renderLocalhostSection(localhost),
    "",
    renderDbSection(db),
    "",
    renderProviderHealthSection(db),
    "",
    renderTaskSection(tasks),
  ].join("\n");
  const reportPath = await writeReport("health", report);
  commandSummary(safety.ready && db.ok ? "PASS" : "WARN", [
    `approval=${safety.requireApproval ? "true" : "NOT CONFIRMED"}`,
    `providerHealth=${db.providerHealth.available ? db.providerHealth.latest.length : "unavailable"}`,
    `scheduledTasks=${tasks.filter((task) => task.found).length} found`,
    `report saved`,
  ], reportPath, "npm run fsc:queue");
  return safety.ready;
}

async function runQueue(command: "queue" | "approval-summary"): Promise<boolean> {
  const safety = getSafetyPosture();
  const db = readDbSnapshot();
  const report = [
    command === "queue" ? "# FEINT SUPPLY CO Approval Queue" : "# FEINT SUPPLY CO Approval Summary",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(safety),
    "",
    renderDbSection(db),
    "",
    renderQueueSection(db, command === "queue" ? "Approval Queue" : "Approval Summary"),
  ].join("\n");
  const reportPath = await writeReport(command, report);
  commandSummary(safety.ready && db.ok ? "PASS" : "WARN", [
    `pendingApprovals=${db.counts.pending_approval ?? 0}`,
    "no approvals performed",
    "no listing state changed",
  ], reportPath, command === "queue" ? "npm run fsc:approval-summary" : "npm run fsc:audit");
  return safety.ready;
}

function renderCommandRun(run: CommandRun): string {
  return [
    `### ${run.command} ${run.args.join(" ")}`,
    "",
    `Result: ${run.ok ? "PASS" : "FAIL"}`,
    `Exit code: ${run.exitCode ?? 0}`,
    "",
    "```text",
    truncate(`${run.stdout}${run.stderr ? `\n${run.stderr}` : ""}`.trim() || "<no output>", 18000),
    "```",
  ].join("\n");
}

async function runVerificationSuite(includeLocalChecks: boolean): Promise<{
  ok: boolean;
  runs: CommandRun[];
  safety: SafetyPosture;
  localhost?: LocalhostCheck[];
  db?: DbSnapshot;
  tasks?: TaskStatus[];
}> {
  const safety = getSafetyPosture();
  const build = await runNpmScript("build");
  const typecheck = await runTypecheck();
  const catalog = await runNpmScript("catalog:verify");
  if (!includeLocalChecks) {
    return { ok: safety.ready && build.ok && typecheck.ok && catalog.ok, runs: [build, typecheck, catalog], safety };
  }

  const [openClaw, dashboard] = await Promise.all([
    fetchLocalhost("OpenClaw Control UI", "http://127.0.0.1:18789/"),
    fetchLocalhost("FEINT SUPPLY CO Dashboard", "http://localhost:4200/"),
  ]);
  const db = readDbSnapshot();
  const tasks = await getScheduledTaskStatuses();
  return {
    ok: safety.ready && build.ok && typecheck.ok && catalog.ok && db.ok,
    runs: [build, typecheck, catalog],
    safety,
    localhost: [openClaw, dashboard],
    db,
    tasks,
  };
}

async function runVerify(): Promise<boolean> {
  const result = await runVerificationSuite(false);
  const report = [
    "# FEINT SUPPLY CO Localhost Verify",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(result.safety),
    "",
    "## Read-Only Verification",
    "",
    "The catalog verifier performs Printful catalog GET requests and writes local report/cache files only. It does not create products, sync variants, publish listings, approve listings, backfill fulfillment, or place orders.",
    "",
    ...result.runs.map(renderCommandRun),
  ].join("\n");
  const reportPath = await writeReport("verify", report);
  commandSummary(result.ok ? "PASS" : "FAIL", [
    `build=${result.runs[0]?.ok ? "pass" : "fail"}`,
    `typecheck=${result.runs[1]?.ok ? "pass" : "fail"}`,
    `catalogVerify=${result.runs[2]?.ok ? "pass" : "fail"}`,
  ], reportPath, "npm run fsc:audit");
  return result.ok;
}

async function runDoctor(): Promise<boolean> {
  const result = await runVerificationSuite(true);
  const report = [
    "# FEINT SUPPLY CO Localhost Doctor",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(result.safety),
    "",
    result.localhost ? renderLocalhostSection(result.localhost) : "",
    "",
    result.db ? renderDbSection(result.db) : "",
    "",
    result.db ? renderProviderHealthSection(result.db) : "",
    "",
    result.tasks ? renderTaskSection(result.tasks) : "",
    "",
    "## Build And Verification",
    "",
    ...result.runs.map(renderCommandRun),
  ].join("\n");
  const reportPath = await writeReport("doctor", report);
  commandSummary(result.ok ? "PASS" : "WARN", [
    `build=${result.runs[0]?.ok ? "pass" : "fail"}`,
    `typecheck=${result.runs[1]?.ok ? "pass" : "fail"}`,
    `catalogVerify=${result.runs[2]?.ok ? "pass" : "fail"}`,
    `db=${result.db?.ok ? "ok" : "not ok"}`,
  ], reportPath, "npm run fsc:status");
  return result.ok;
}

async function runAudit(): Promise<boolean> {
  const safety = getSafetyPosture();
  const scripts = readPackageScripts();
  const dangerousScripts = Object.entries(scripts)
    .filter(([name]) => /^(publish|pod-publish|orders|backfill:printful|go-live|heartbeat|orderwatch)$/.test(name))
    .map(([name, command]) => ({ name, command }));
  const tasks = await getScheduledTaskStatuses();
  const report = [
    "# FEINT SUPPLY CO Localhost Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    renderSafetySection(safety),
    "",
    "## Dangerous Scripts Present But Not Executed",
    "",
    dangerousScripts.length === 0
      ? "No dangerous scripts were found in package.json."
      : buildTable(
          ["Script", "Command", "Audit Note"],
          dangerousScripts.map((script) => [script.name, script.command, "present but not executed by this bridge"]),
        ),
    "",
    renderTaskSection(tasks),
    "",
    "## Redaction",
    "",
    "The bridge redacts token-like strings, bearer tokens, API-key assignments, OAuth secrets, passwords, and Discord webhook URLs before writing command output to reports.",
  ].join("\n");
  const reportPath = await writeReport("audit", report);
  commandSummary(safety.ready ? "PASS" : "FAIL", [
    `REQUIRE_APPROVAL=${safety.requireApproval ? "true" : "NOT CONFIRMED"}`,
    `MAX_LISTINGS_PER_DAY=${safety.maxListingsPerDay ?? "missing"}`,
    `dangerousScriptsPresent=${dangerousScripts.length}`,
    "dangerous scripts not executed",
  ], reportPath, "npm run fsc:status");
  return safety.ready;
}

async function refuseCommand(rawCommand: string): Promise<void> {
  const report = [
    "# FEINT SUPPLY CO Bridge Refusal",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Requested command: \`${markdownEscape(rawCommand || "<missing>")}\``,
    "",
    "Result: refused.",
    "",
    "This bridge is localhost-first and read-only by default. Publishing, dashboard approvals, Printful backfill, fulfillment, test orders, live mutations, and credential changes require a future explicit human-approval flag that is not implemented in this pass.",
  ].join("\n");
  const reportPath = await writeReport("refused", report);
  commandSummary("FAIL", [
    `refused=${rawCommand || "<missing>"}`,
    `supported=${SUPPORTED_COMMANDS.join(", ")}`,
  ], reportPath, "npm run fsc:status");
}

async function dispatch(command: BridgeCommand): Promise<boolean> {
  if (command === "status") return runStatus();
  if (command === "health") return runHealth();
  if (command === "queue") return runQueue("queue");
  if (command === "approval-summary") return runQueue("approval-summary");
  if (command === "verify") return runVerify();
  if (command === "doctor") return runDoctor();
  if (command === "audit") return runAudit();
  return false;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  const rawCommand = process.argv[2] ?? "status";
  if (!SUPPORTED_COMMANDS.includes(rawCommand as BridgeCommand)) {
    await refuseCommand(rawCommand);
    process.exitCode = 2;
    return;
  }

  const ok = await dispatch(rawCommand as BridgeCommand);
  if (!ok && ["verify", "doctor", "audit"].includes(rawCommand)) {
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
