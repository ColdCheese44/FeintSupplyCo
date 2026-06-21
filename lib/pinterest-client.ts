import "dotenv/config";

import { createLogger } from "./logger.js";

export interface PinterestPinInput {
  title: string;
  description: string;
  imageUrl: string;
  link?: string;
  boardId?: string;
}

export interface PinterestPinResult {
  id: string;
  link?: string;
}

export interface PinterestApiErrorDetails {
  endpoint: string;
  status: number;
  statusText: string;
  errorCode?: string;
  errorMessage?: string;
  scopes?: string[];
  bodyPreview?: unknown;
}

export interface PinterestDiagnosticCheck {
  endpoint: string;
  httpStatus: number;
  status: "PASS" | "INVALID CREDENTIAL" | "DEGRADED" | "UNREACHABLE";
  scope: string;
  note: string;
  sample?: unknown;
}

const logger = createLogger("pinterest-client");
const pinterestApiBaseUrl = "https://api.pinterest.com/v5";

/**
 * Returns the configured Pinterest token and fails fast when it is missing.
 */
function getPinterestAccessToken(): string {
  const token = process.env.PINTEREST_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("PINTEREST_ACCESS_TOKEN is missing. Add it to the project .env file before using Pinterest.");
  }
  return token;
}

/**
 * Returns the configured Pinterest board ID or the override passed by the caller.
 */
function getPinterestBoardId(override?: string): string {
  const boardId = override ?? process.env.PINTEREST_BOARD_ID?.trim();
  if (!boardId) {
    throw new Error("PINTEREST_BOARD_ID is missing. Add it to the project .env file before using Pinterest.");
  }
  return boardId;
}

/**
 * Converts a Pinterest error response into structured detail that smoke tests and diagnostics can surface clearly.
 */
async function parsePinterestError(endpoint: string, response: Response): Promise<PinterestApiErrorDetails> {
  let bodyPreview: unknown = null;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let scopes: string[] | undefined;

  try {
    const payload = (await response.json()) as Record<string, unknown>;
    bodyPreview = payload;
    errorCode = String(payload.code ?? payload.error_code ?? "");
    errorMessage = String(payload.message ?? payload.error_message ?? payload.error ?? "");

    const scopeCandidate = payload.scopes ?? payload.scope ?? payload.granted_scopes;
    if (Array.isArray(scopeCandidate)) {
      scopes = scopeCandidate.map((item) => String(item));
    } else if (typeof scopeCandidate === "string" && scopeCandidate.trim()) {
      scopes = scopeCandidate
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    bodyPreview = await response.text();
  }

  return {
    endpoint,
    status: response.status,
    statusText: response.statusText,
    errorCode: errorCode || undefined,
    errorMessage: errorMessage || undefined,
    scopes,
    bodyPreview,
  };
}

/**
 * Executes an authenticated Pinterest request and leaves body parsing to the caller.
 */
async function pinterestRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getPinterestAccessToken()}`);
  headers.set("Accept", "application/json");

  return fetch(`${pinterestApiBaseUrl}${path}`, {
    ...init,
    headers,
  });
}

/**
 * Formats a Pinterest error into a compact human-readable string for logs and smoke output.
 */
function formatPinterestError(details: PinterestApiErrorDetails): string {
  const parts = [
    `${details.status} ${details.statusText}`,
    details.errorCode ? `code=${details.errorCode}` : "",
    details.errorMessage ? `message=${details.errorMessage}` : "",
    details.scopes?.length ? `scopes=${details.scopes.join(",")}` : "",
  ].filter(Boolean);

  return parts.join(" | ");
}

/**
 * Publishes a Pinterest pin using a remote image URL so the heartbeat loop can drive organic traffic.
 */
export async function createPinterestPin(input: PinterestPinInput): Promise<PinterestPinResult> {
  try {
    logger.action("Creating Pinterest pin", "start", { title: input.title });
    const response = await pinterestRequest("/pins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        board_id: getPinterestBoardId(input.boardId),
        title: input.title,
        description: input.description,
        link: input.link,
        media_source: {
          source_type: "image_url",
          url: input.imageUrl,
        },
      }),
    });

    if (!response.ok) {
      const details = await parsePinterestError("/pins", response);
      throw new Error(`Pinterest pin creation failed: ${formatPinterestError(details)}`);
    }

    const payload = (await response.json()) as { id: string; link?: string };
    logger.action("Created Pinterest pin", "success", { pinId: payload.id });
    return payload;
  } catch (error) {
    logger.error("Pinterest pin creation failed", error, { title: input.title });
    throw new Error(`Pinterest pin creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads one Pinterest endpoint for diagnostics and returns a scope-focused health result.
 */
async function runDiagnosticCheck(
  path: string,
  scope: string,
): Promise<PinterestDiagnosticCheck> {
  try {
    const response = await pinterestRequest(path, { method: "GET" });
    if (!response.ok) {
      const details = await parsePinterestError(path, response);
      const isAuthFailure = response.status === 401 || response.status === 403;
      return {
        endpoint: path,
        httpStatus: response.status,
        status: isAuthFailure ? "INVALID CREDENTIAL" : "DEGRADED",
        scope,
        note: formatPinterestError(details),
        sample: details.bodyPreview,
      };
    }

    let sample: unknown = null;
    try {
      sample = await response.json();
    } catch {
      sample = { status: response.status, statusText: response.statusText };
    }

    return {
      endpoint: path,
      httpStatus: response.status,
      status: "PASS",
      scope,
      note: `${scope} confirmed`,
      sample,
    };
  } catch (error) {
    return {
      endpoint: path,
      httpStatus: 0,
      status: "UNREACHABLE",
      scope,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Runs the three read-only Pinterest checks needed to validate token health and basic read scopes.
 */
export async function diagnosePinterestReadAccess(): Promise<PinterestDiagnosticCheck[]> {
  return Promise.all([
    runDiagnosticCheck("/user_account", "user_accounts:read"),
    runDiagnosticCheck("/boards?page_size=5", "boards:read"),
    runDiagnosticCheck("/pins?page_size=1", "pins:read"),
  ]);
}
