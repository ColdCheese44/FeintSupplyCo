import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

import {
  buildFeintBrowserArgs,
  findFeintBrowserExecutable,
  normalizeFeintBrowserMode,
} from "../lib/browser-launcher.js";

const originalEnv = {
  FEINT_BROWSER: process.env.FEINT_BROWSER,
  FEINT_BROWSER_MODE: process.env.FEINT_BROWSER_MODE,
  FEINT_BROWSER_PATH: process.env.FEINT_BROWSER_PATH,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

try {
  delete process.env.FEINT_BROWSER_MODE;
  assert.equal(normalizeFeintBrowserMode(), "fullscreen");
  assert.equal(normalizeFeintBrowserMode("maximized"), "maximized");
  assert.equal(normalizeFeintBrowserMode("normal"), "normal");
  assert.equal(normalizeFeintBrowserMode("kiosk"), "kiosk");
  assert.equal(normalizeFeintBrowserMode("sideways"), "fullscreen");

  assert.deepEqual(
    buildFeintBrowserArgs("http://localhost:4200", "fullscreen"),
    ["--new-window", "--start-fullscreen", "http://localhost:4200"],
  );
  assert.deepEqual(
    buildFeintBrowserArgs("http://localhost:4200", "normal"),
    ["--new-window", "http://localhost:4200"],
  );

  const tempDir = mkdtempSync(join(tmpdir(), "feint-browser-"));
  const fakeBrowserPath = join(tempDir, process.platform === "win32" ? "brave.exe" : "brave");
  writeFileSync(fakeBrowserPath, "", "utf8");
  process.env.FEINT_BROWSER_PATH = fakeBrowserPath;
  assert.equal(findFeintBrowserExecutable(), fakeBrowserPath);
  rmSync(tempDir, { recursive: true, force: true });

  console.log("Browser launcher tests passed.");
} finally {
  restoreEnv();
}
