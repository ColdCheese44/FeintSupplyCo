import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import Replicate from "replicate";

import { createLogger } from "./logger.js";

interface GenerateImageOptions {
  model?: string;
  destinationPath: string;
  width?: number;
  height?: number;
}

export interface ReplicateImageResult {
  destinationPath: string;
  imageUrl: string;
  model: string;
}

const logger = createLogger("replicate-client");
const defaultModel = "black-forest-labs/flux-schnell";
const sdxlModel = "stability-ai/sdxl";
let replicateClient: Replicate | null = null;

/**
 * Casts a configured model name into the identifier shape expected by the Replicate SDK.
 */
function getReplicateModelIdentifier(model?: string): `${string}/${string}` | `${string}/${string}:${string}` {
  return (model ?? defaultModel) as `${string}/${string}` | `${string}/${string}:${string}`;
}

/**
 * Lazily constructs the Replicate client so missing credentials surface only on image-generation calls.
 */
function getReplicateClient(): Replicate {
  if (replicateClient) {
    return replicateClient;
  }

  const auth = process.env.REPLICATE_API_TOKEN?.trim();
  if (!auth) {
    throw new Error("REPLICATE_API_TOKEN is missing. Add it to the project .env file before generating images.");
  }

  replicateClient = new Replicate({ auth });
  return replicateClient;
}

/**
 * Normalizes Replicate output shapes into a single downloadable URL string.
 */
function extractReplicateOutputUrl(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (output instanceof URL) {
    return output.toString();
  }

  if (Array.isArray(output) && output.length > 0) {
    return extractReplicateOutputUrl(output[0]);
  }

  if (output && typeof output === "object") {
    const maybeWithUrl = output as { url?: string | (() => string) };
    if (typeof maybeWithUrl.url === "string") {
      return maybeWithUrl.url;
    }
    if (typeof maybeWithUrl.url === "function") {
      return maybeWithUrl.url();
    }

    const textValue = String(output);
    if (textValue && textValue !== "[object Object]") {
      return textValue;
    }
  }

  throw new Error("Replicate returned an unexpected output shape for the generated image.");
}

/**
 * Downloads a generated image to disk so Etsy publishing can upload a local file later.
 */
export async function downloadImageToFile(url: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

/**
/**
 * Writes base64-encoded image bytes to disk so image APIs that return inline content can share the same output flow.
 */
export async function writeBase64ImageToFile(base64Data: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, Buffer.from(base64Data, "base64"));
}

/**
 * Runs a Replicate image model and persists the first returned image to a local file path.
 */
export async function generateImageToPath(prompt: string, options: GenerateImageOptions): Promise<string> {
  const result = await generateReplicateImage(prompt, options);
  return result.destinationPath;
}

/**
 * Runs a Replicate image model and returns the saved file path plus source metadata for downstream tracking.
 */
export async function generateReplicateImage(prompt: string, options: GenerateImageOptions): Promise<ReplicateImageResult> {
  const client = getReplicateClient();
  const modelIdentifier = getReplicateModelIdentifier(options.model);
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;

  try {
    logger.action("Submitting Replicate image generation job", "start", {
      model: modelIdentifier,
      destinationPath: options.destinationPath,
    });

    const output = modelIdentifier.startsWith(sdxlModel)
      ? await client.run(modelIdentifier, {
        input: {
          prompt,
          width,
          height,
        },
      })
      : await client.run(modelIdentifier, {
        input: {
          prompt,
          aspect_ratio: options.width && options.height ? `${options.width}:${options.height}` : "1:1",
          output_format: "png",
        },
      });

    const imageUrl = extractReplicateOutputUrl(output);
    await downloadImageToFile(imageUrl, options.destinationPath);
    logger.action("Replicate image saved locally", "success", {
      destinationPath: options.destinationPath,
      imageUrl,
    });

    return {
      destinationPath: options.destinationPath,
      imageUrl,
      model: modelIdentifier,
    };
  } catch (error) {
    logger.error("Replicate image generation failed", error, { destinationPath: options.destinationPath });
    throw new Error(`Replicate image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
