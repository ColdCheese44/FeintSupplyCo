import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import OpenAI from "openai";

import { createLogger } from "./logger.js";
export interface OpenAITextOptions {
  model?: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface OpenAITextResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface OpenAIImageOptions {
  model?: string;
  destinationPath: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "standard" | "hd" | "low" | "medium" | "high";
  background?: "transparent" | "opaque" | "auto";
}

export interface OpenAIImageResult {
  destinationPath: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const logger = createLogger("openai-client");
let openAiClient: OpenAI | null = null;

/**
 * Returns a resilient image model fallback when legacy DALL-E aliases are unavailable for the current account.
 */
function getFallbackImageModel(model: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (model === "dall-e-3" && message.includes("does not exist")) {
    return "gpt-image-1";
  }
  return null;
}

/**
 * Normalizes image quality values so one call shape can work across legacy DALL-E and current GPT Image models.
 */
function resolveImageQuality(model: string, quality: OpenAIImageOptions["quality"]): "standard" | "hd" | "low" | "medium" | "high" {
  const requestedQuality = quality ?? "standard";
  if (model.startsWith("gpt-image-")) {
    if (requestedQuality === "standard") {
      return "medium";
    }
    if (requestedQuality === "hd") {
      return "high";
    }
    return requestedQuality;
  }

  if (requestedQuality === "low" || requestedQuality === "medium" || requestedQuality === "high") {
    return "standard";
  }
  return requestedQuality;
}

/**
 * Lazily constructs the OpenAI client so missing credentials surface only when the provider is actually used.
 */
function getOpenAIClient(): OpenAI {
  if (openAiClient) {
    return openAiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Add it to the project .env file before calling OpenAI.");
  }

  openAiClient = new OpenAI({ apiKey });
  return openAiClient;
}

/**
 * Runs a text prompt through the Responses API and returns normalized text plus usage metadata.
 */
export async function generateOpenAIText(prompt: string, options: OpenAITextOptions = {}): Promise<OpenAITextResult> {
  const client = getOpenAIClient();
  const model = options.model ?? "gpt-4.1";

  try {
    logger.action("Sending prompt to OpenAI", "start", { model });
    const response = await client.responses.create({
      model,
      instructions: options.system,
      input: prompt,
      temperature: options.temperature ?? 0.4,
      max_output_tokens: options.maxOutputTokens ?? 1_024,
    });

    const usage = response.usage;
    const result: OpenAITextResult = {
      text: response.output_text,
      model,
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
    };
    logger.action("OpenAI response received", "success", { model, characters: result.text.length });
    return result;
  } catch (error) {
    logger.error("OpenAI text generation failed", error, { model, promptPreview: prompt.slice(0, 200) });
    throw new Error(`OpenAI text generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Downloads a remote image URL to disk with one retry so short-lived provider URLs still save reliably.
 */
async function downloadOpenAIImage(url: string, destinationPath: string, attempt = 1): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OpenAI image download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await writeFile(destinationPath, Buffer.from(arrayBuffer));
  } catch (error) {
    if (attempt >= 2) {
      throw error;
    }

    logger.warn("OpenAI image download failed; retrying once", {
      destinationPath,
      attempt,
      error: error instanceof Error ? error.message : String(error),
    });
    await downloadOpenAIImage(url, destinationPath, attempt + 1);
  }
}

/**
 * Runs the OpenAI Images API and saves the resulting image to a local file.
 */
export async function generateOpenAIImageToPath(prompt: string, options: OpenAIImageOptions): Promise<OpenAIImageResult> {
  const client = getOpenAIClient();
  const requestedModel = options.model ?? "gpt-image-1";
  let model = requestedModel;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
    logger.action("Submitting image prompt to OpenAI", "start", { model, destinationPath: options.destinationPath });
      const response = await client.images.generate({
        model,
        prompt,
        size: options.size ?? "1024x1024",
        quality: resolveImageQuality(model, options.quality),
      });

      const image = response.data?.[0];
      const imageUrl = image?.url?.trim();
      const base64Image = image?.b64_json?.trim();
      await mkdir(dirname(options.destinationPath), { recursive: true });

      if (imageUrl) {
        await downloadOpenAIImage(imageUrl, options.destinationPath);
      } else if (base64Image) {
        await writeFile(options.destinationPath, Buffer.from(base64Image, "base64"));
      } else {
        throw new Error("OpenAI image generation did not return a downloadable image URL or base64 data.");
      }

      const usage = response.usage;
      const result: OpenAIImageResult = {
        destinationPath: options.destinationPath,
        model,
        promptTokens: usage?.input_tokens ?? 0,
        completionTokens: usage?.output_tokens ?? 0,
      };
      logger.action("OpenAI image saved locally", "success", result);
      return result;
    } catch (error) {
      const fallbackModel = getFallbackImageModel(model, error);
      if (fallbackModel && attempt === 1) {
        logger.warn("Requested OpenAI image model unavailable; retrying with supported fallback", {
          requestedModel,
          fallbackModel,
          destinationPath: options.destinationPath,
        });
        model = fallbackModel;
        continue;
      }

      logger.error("OpenAI image generation failed", error, { model, destinationPath: options.destinationPath });
      throw new Error(`OpenAI image generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`OpenAI image generation failed: exhausted retry path for requested model ${requestedModel}.`);
}
