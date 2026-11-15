import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export type FeintBrowserMode = "fullscreen" | "maximized" | "normal" | "kiosk";

const DEFAULT_BROWSER = "brave";
const DEFAULT_MODE: FeintBrowserMode = "fullscreen";

const WINDOWS_BRAVE_PATHS = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  join(process.env.LOCALAPPDATA ?? "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
];

const BRAVE_COMMANDS = process.platform === "win32"
  ? ["brave.exe", "brave-browser.exe"]
  : ["brave", "brave-browser"];

/**
 * Normalizes a requested browser mode. Unknown values intentionally fall back to fullscreen.
 */
export function normalizeFeintBrowserMode(mode?: string | null): FeintBrowserMode {
  const normalized = (mode ?? process.env.FEINT_BROWSER_MODE ?? DEFAULT_MODE).trim().toLowerCase();
  if (normalized === "fullscreen" || normalized === "maximized" || normalized === "normal" || normalized === "kiosk") {
    return normalized;
  }

  return DEFAULT_MODE;
}

/**
 * Builds the Brave command-line arguments used for human-facing browser windows.
 */
export function buildFeintBrowserArgs(url: string, mode?: string | null): string[] {
  const args = ["--new-window"];

  switch (normalizeFeintBrowserMode(mode)) {
    case "fullscreen":
      args.push("--start-fullscreen");
      break;
    case "maximized":
      args.push("--start-maximized");
      break;
    case "kiosk":
      args.push("--kiosk");
      break;
    case "normal":
      break;
  }

  args.push(url);
  return args;
}

/**
 * Finds an executable on PATH without requiring a shell.
 */
function findOnPath(command: string): string | null {
  const pathValue = process.env.PATH ?? "";
  if (!pathValue) {
    return null;
  }

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const commandExtensions = extname(command) ? [""] : extensions;

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const extension of commandExtensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Resolves the preferred Feint browser. Brave is the default; FEINT_BROWSER_PATH wins when valid.
 */
export function findFeintBrowserExecutable(): string | null {
  const explicitPath = process.env.FEINT_BROWSER_PATH?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const requestedBrowser = (process.env.FEINT_BROWSER ?? DEFAULT_BROWSER).trim();
  const requestedBrowserLower = requestedBrowser.toLowerCase();
  if (requestedBrowserLower === "default" || requestedBrowserLower === "system") {
    return null;
  }

  if (requestedBrowser && isAbsolute(requestedBrowser) && existsSync(requestedBrowser)) {
    return requestedBrowser;
  }

  const windowsCandidates = process.platform === "win32" ? WINDOWS_BRAVE_PATHS : [];
  for (const candidate of windowsCandidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const pathCommands = requestedBrowserLower === DEFAULT_BROWSER
    ? BRAVE_COMMANDS
    : [requestedBrowser, ...BRAVE_COMMANDS];
  for (const command of pathCommands) {
    const resolved = findOnPath(command);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Opens a URL in the OS default browser as a safe fallback when Brave is unavailable.
 */
function openWithDefaultBrowser(url: string): boolean {
  try {
    const command = process.platform === "win32"
      ? "powershell.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -FilePath $args[0]", url]
      : [url];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a human-facing URL in the Feint browser. Browser launch failures never fail the caller.
 */
export function openInFeintBrowser(url: string, mode?: string | null): boolean {
  const browser = findFeintBrowserExecutable();

  if (browser) {
    try {
      const child = spawn(browser, buildFeintBrowserArgs(url, mode), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch (error) {
      console.warn(`Brave launch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.warn("Brave not found. Falling back to the default browser.");
  }

  return openWithDefaultBrowser(url);
}
