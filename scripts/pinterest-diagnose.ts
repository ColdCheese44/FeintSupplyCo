import "dotenv/config";

import { diagnosePinterestReadAccess, type PinterestDiagnosticCheck } from "../lib/pinterest-client.js";
import { renderTextTable } from "../lib/text-table.js";

/**
 * Extracts board rows from the Pinterest boards response sample when available.
 */
function extractBoards(check: PinterestDiagnosticCheck): Array<{ id: string; name: string }> {
  const sample = check.sample as { items?: Array<{ id?: string; name?: string }> } | undefined;
  return (sample?.items ?? [])
    .map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
    }))
    .filter((item) => item.id);
}

/**
 * Converts the diagnostic checks into a console-friendly text table.
 */
function renderChecks(checks: PinterestDiagnosticCheck[]): string {
  return renderTextTable(
    ["Endpoint", "Status", "Scope Check"],
    checks.map((check) => [check.endpoint, check.status, check.note]),
  );
}

/**
 * Runs the Pinterest read-scope diagnostics without performing any write call.
 */
async function main(): Promise<void> {
  if (!process.env.PINTEREST_ACCESS_TOKEN?.trim()) {
    console.error("PINTEREST_ACCESS_TOKEN is missing in .env.");
    process.exitCode = 1;
    return;
  }

  const checks = await diagnosePinterestReadAccess();
  console.log(renderChecks(checks));

  const boardsCheck = checks.find((check) => check.endpoint.startsWith("/boards"));
  const boards = boardsCheck ? extractBoards(boardsCheck) : [];
  if (boards.length > 0) {
    console.log("");
    console.log("Boards");
    console.log(renderTextTable(
      ["Board ID", "Board Name"],
      boards.map((board) => [board.id, board.name]),
    ));
  }

  const allPassed = checks.every((check) => check.status === "PASS");
  if (allPassed && boards.length > 0) {
    console.log("");
    console.log("All Pinterest read checks passed.");
    console.log("Pick a board ID from the table above and write it to PINTEREST_BOARD_ID in .env.");
  }

  if (!allPassed) {
    process.exitCode = 1;
  }
}

await main();
