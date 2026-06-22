import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { exec, type ExecException } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");
const debugMode = process.argv.includes("--debug");
const callbackPort = (() => {
  const parsed = Number.parseInt(process.env.PORT ?? "3000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
})();
const redirectUri = `http://localhost:${callbackPort}/oauth/callback`;
const scope = "listings_r listings_w shops_r shops_w transactions_r email_r profile_r";
const tokenUrl = "https://api.etsy.com/v3/public/oauth/token";
const authorizationBaseUrl = "https://www.etsy.com/oauth/connect";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Reads the project .env file so OAuth writes update the same persisted values FeintSupplyCo uses elsewhere.
 */
function readEnvState(): Record<string, string | undefined> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8")) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/**
 * Writes or appends one .env value while preserving unrelated configuration lines.
 */
function writeEnvValue(key: string, value: string): void {
  const existingLines = (() => {
    try {
      return readFileSync(envPath, "utf8").split(/\r?\n/);
    } catch {
      return [];
    }
  })();

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
 * Returns the Etsy x-api-key header value documented for authenticated Open API v3 requests.
 */
function getEtsyApiKeyHeader(apiKey: string, apiSecret: string): string {
  return `${apiKey}:${apiSecret}`;
}

/**
 * Encodes raw bytes as base64url so the result is valid for PKCE values and URL transport.
 */
function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Validates the PKCE verifier and challenge against Etsy's documented format constraints.
 */
function assertPkceFormat(codeVerifier: string, codeChallenge: string): void {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    throw new Error("Generated PKCE code_verifier does not meet Etsy's required format.");
  }

  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error("Generated PKCE code_challenge does not meet Etsy's required format.");
  }
}

/**
 * Generates a cryptographically strong PKCE verifier/challenge pair for the Etsy authorization code flow.
 */
function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(randomBytes(64));
  const codeChallenge = toBase64Url(createHash("sha256").update(codeVerifier).digest());
  assertPkceFormat(codeVerifier, codeChallenge);
  return { codeVerifier, codeChallenge };
}

/**
 * Generates a random state nonce so the callback can reject CSRF mismatches safely.
 */
function createStateNonce(): string {
  return toBase64Url(randomBytes(24));
}

/**
 * Opens the Etsy authorization URL in the default Windows browser and falls back to manual instructions on failure.
 */
async function launchBrowser(url: string): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    exec(`start "" "${url.replace(/"/g, '""')}"`, { shell: true as unknown as string }, (error: ExecException | null) => {
      if (error) {
        console.warn(`Browser auto-launch failed: ${error.message}`);
        console.warn(`Open this URL manually: ${url}`);
      }
      resolvePromise();
    });
  });
}

/**
 * Waits for the Etsy localhost callback, validates state, returns the code, and times out after two minutes.
 */
async function waitForOAuthCallback(expectedState: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        if (requestUrl.pathname !== "/oauth/callback") {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");

        if (error) {
          response.statusCode = 400;
          response.end("Etsy returned an OAuth error. You can close this tab.");
          cleanup(new Error(`Etsy OAuth returned error=${error}`));
          return;
        }

        if (!code || !state) {
          response.statusCode = 400;
          response.end("Missing OAuth callback parameters. You can close this tab.");
          cleanup(new Error("Etsy OAuth callback did not include both code and state."));
          return;
        }

        if (state !== expectedState) {
          response.statusCode = 400;
          response.end("State mismatch. You can close this tab.");
          cleanup(new Error("Etsy OAuth state mismatch. Aborting for safety."));
          return;
        }

        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Authentication successful. You can close this tab.");
        cleanup(undefined, code);
      } catch (error) {
        cleanup(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const timeout = setTimeout(() => {
      cleanup(new Error(`Timed out waiting 120 seconds for the Etsy OAuth callback on ${redirectUri}. Try again after confirming the redirect URI.`));
    }, 120_000);

    /**
     * Closes the local callback server once and settles the waiting promise exactly one time.
     */
    function cleanup(error?: Error, code?: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      server.close(() => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(code ?? "");
      });
    }

    server.on("error", (error) => {
      cleanup(new Error(`Failed to bind localhost callback server on port ${callbackPort}: ${error.message}`));
    });

    server.listen(callbackPort);
  });
}

/**
 * Exchanges the Etsy authorization code for an access token and refresh token using the PKCE verifier.
 */
async function exchangeCodeForTokens(apiKey: string, code: string, codeVerifier: string): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: apiKey,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Etsy token exchange failed: ${response.status} ${response.statusText}\n${bodyText}`);
  }

  try {
    return JSON.parse(bodyText) as TokenResponse;
  } catch (error) {
    throw new Error(`Etsy token exchange returned non-JSON content: ${error instanceof Error ? error.message : String(error)}\n${bodyText}`);
  }
}

/**
 * Validates the freshly issued token by calling getUser and returning the parsed response for operator review.
 */
async function validateAccessToken(apiKey: string, apiSecret: string, accessToken: string, userId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://openapi.etsy.com/v3/application/users/${encodeURIComponent(userId)}`, {
    method: "GET",
    headers: {
      "x-api-key": getEtsyApiKeyHeader(apiKey, apiSecret),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth validation failed: ${response.status} ${response.statusText}\n${bodyText}`);
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`OAuth validation returned non-JSON content: ${error instanceof Error ? error.message : String(error)}\n${bodyText}`);
  }
}

/**
 * Redacts a token to a short preview that confirms persistence without printing the full secret value.
 */
function redactTokenPreview(token: string): string {
  return `${token.slice(0, 8)}...`;
}

/**
 * Runs the standalone Etsy OAuth helper from auth URL generation through token validation.
 */
async function main(): Promise<void> {
  const envState = readEnvState();
  const apiKey = (envState.ETSY_API_KEY ?? process.env.ETSY_API_KEY ?? "").trim();
  const apiSecret = (envState.ETSY_API_SECRET ?? process.env.ETSY_API_SECRET ?? "").trim();
  const userId = (envState.ETSY_USER_ID ?? process.env.ETSY_USER_ID ?? "").trim();
  if (!apiKey) {
    throw new Error("ETSY_API_KEY is required in .env before running npm run etsy:oauth.");
  }
  if (!apiSecret) {
    throw new Error("ETSY_API_SECRET is required in .env before running npm run etsy:oauth.");
  }
  if (!userId) {
    throw new Error("ETSY_USER_ID is required in .env before running npm run etsy:oauth.");
  }

  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createStateNonce();
  if (debugMode) {
    console.log(`PKCE code_verifier: ${codeVerifier}`);
    console.log(`PKCE code_challenge: ${codeChallenge}`);
  }

  const authorizationUrl = new URL(authorizationBaseUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", apiKey);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Open this URL if the browser does not launch automatically:");
  console.log(authorizationUrl.toString());
  await launchBrowser(authorizationUrl.toString());

  const code = await waitForOAuthCallback(state);
  const tokenPayload = await exchangeCodeForTokens(apiKey, code, codeVerifier);
  if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
    throw new Error("Etsy token exchange succeeded but did not return both access_token and refresh_token.");
  }

  writeEnvValue("ETSY_ACCESS_TOKEN", tokenPayload.access_token);
  writeEnvValue("ETSY_REFRESH_TOKEN", tokenPayload.refresh_token);
  console.log(`Stored ETSY_ACCESS_TOKEN (${redactTokenPreview(tokenPayload.access_token)}) in .env.`);
  console.log(`Stored ETSY_REFRESH_TOKEN (${redactTokenPreview(tokenPayload.refresh_token)}) in .env.`);

  try {
    const userPayload = await validateAccessToken(apiKey, apiSecret, tokenPayload.access_token, userId);
    console.log("✓ OAuth validated - token works");
    console.log(`Authenticated Etsy user id: ${String(userPayload.user_id ?? "unknown")}`);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    console.warn("OAuth completed, but the validation request failed. Review the response above before proceeding.");
  }
}

await main();
