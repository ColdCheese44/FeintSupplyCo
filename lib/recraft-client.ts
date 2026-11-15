import "dotenv/config";

import { createLogger } from "./logger.js";
import { writeBase64ImageToFile } from "./replicate-client.js";

export interface RecraftGenerateOptions {
  destinationPaths: string[];
  model?: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
}

export interface RecraftGenerateResult {
  destinationPaths: string[];
  model: string;
}

interface RecraftImageResponse {
  data?: Array<{ b64_json?: string }>;
}

const logger = createLogger("recraft-client");

/**
 * Recraft exposes an OpenAI-compatible images endpoint. FeintSupplyCo calls it over plain
 * fetch rather than through the OpenAI SDK so the project carries no OpenAI dependency.
 */
const recraftApiBaseUrl = "https://external.api.recraft.ai/v1";

/**
 * Reads the Recraft credential and fails clearly when the provider has not been configured.
 */
function getRecraftApiKey(): string {
  const apiKey = process.env.RECRAFT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RECRAFT_API_KEY is missing. Add it to the project .env file before using Recraft.");
  }
  return apiKey;
}

/**
 * Generates one or more Recraft images and saves them locally for downstream publishing or marketing use.
 */
export async function generateRecraftImages(prompt: string, options: RecraftGenerateOptions): Promise<RecraftGenerateResult> {
  const apiKey = getRecraftApiKey();
  const model = options.model ?? "recraftv4";

  try {
    logger.action("Submitting image prompt to Recraft", "start", { model, destinationCount: options.destinationPaths.length });

    const response = await fetch(`${recraftApiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        size: options.size ?? "1024x1024",
        response_format: "b64_json",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "<unreadable body>");
      throw new Error(`Recraft request failed: ${response.status} ${response.statusText} - ${errorBody.slice(0, 400)}`);
    }

    const payload = (await response.json()) as RecraftImageResponse;
    const base64Image = payload.data?.[0]?.b64_json;
    if (!base64Image) {
      throw new Error("Recraft did not return base64 image data.");
    }

    await Promise.all(
      options.destinationPaths.map((destinationPath) => writeBase64ImageToFile(base64Image, destinationPath)),
    );
    logger.action("Recraft images saved locally", "success", { model, destinationCount: options.destinationPaths.length });
    return {
      destinationPaths: options.destinationPaths,
      model,
    };
  } catch (error) {
    logger.error("Recraft image generation failed", error, { model, promptPreview: prompt.slice(0, 120) });
    throw new Error(`Recraft image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
