import "dotenv/config";

import OpenAI from "openai";

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

const logger = createLogger("recraft-client");
let recraftClient: OpenAI | null = null;

/**
 * Lazily constructs the Recraft API client using its OpenAI-compatible interface.
 */
function getRecraftClient(): OpenAI {
  if (recraftClient) {
    return recraftClient;
  }

  const apiKey = process.env.RECRAFT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RECRAFT_API_KEY is missing. Add it to the project .env file before using Recraft.");
  }

  recraftClient = new OpenAI({
    apiKey,
    baseURL: "https://external.api.recraft.ai/v1",
  });
  return recraftClient;
}

/**
 * Generates one or more Recraft images and saves them locally for downstream publishing or marketing use.
 */
export async function generateRecraftImages(prompt: string, options: RecraftGenerateOptions): Promise<RecraftGenerateResult> {
  const client = getRecraftClient();
  const model = options.model ?? "recraftv4";

  try {
    logger.action("Submitting image prompt to Recraft", "start", { model, destinationCount: options.destinationPaths.length });
    const response = await client.images.generate({
      model,
      prompt,
      size: options.size ?? "1024x1024",
      response_format: "b64_json",
    });

    const firstImage = response.data?.[0];
    if (!firstImage?.b64_json) {
      throw new Error("Recraft did not return base64 image data.");
    }

    await Promise.all(options.destinationPaths.map((destinationPath) => writeBase64ImageToFile(firstImage.b64_json as string, destinationPath)));
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
