import "dotenv/config";

import { createLogger } from "./logger.js";
import { downloadImageToFile } from "./replicate-client.js";

export interface IdeogramGenerateOptions {
  destinationPaths: string[];
  aspectRatio?: string;
  transparentBackground?: boolean;
  renderingSpeed?: "TURBO" | "DEFAULT" | "QUALITY";
}

export interface IdeogramGenerateResult {
  destinationPaths: string[];
  model: string;
}

const logger = createLogger("ideogram-client");
const ideogramApiBaseUrl = "https://api.ideogram.ai/v1";

/**
 * Returns the configured Ideogram key and fails fast when it is missing.
 */
function getIdeogramApiKey(): string {
  const apiKey = process.env.IDEOGRAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("IDEOGRAM_API_KEY is missing. Add it to the project .env file before using Ideogram.");
  }
  return apiKey;
}

/**
 * Extracts image URLs from the different response shapes Ideogram may return.
 */
function extractIdeogramUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const source = payload as {
    data?: Array<{ url?: string; image_url?: string }>;
    images?: Array<{ url?: string; image_url?: string }>;
  };

  const candidates = source.data ?? source.images ?? [];
  return candidates
    .map((item) => item.url ?? item.image_url ?? "")
    .filter((value): value is string => Boolean(value));
}

/**
 * Generates one or more Ideogram images and saves them to the requested local paths.
 */
export async function generateIdeogramImages(prompt: string, options: IdeogramGenerateOptions): Promise<IdeogramGenerateResult> {
  try {
    logger.action("Submitting image prompt to Ideogram", "start", {
      destinationCount: options.destinationPaths.length,
      transparentBackground: options.transparentBackground ?? false,
    });

    const endpoint = options.transparentBackground
      ? `${ideogramApiBaseUrl}/ideogram-v3/generate-transparent`
      : `${ideogramApiBaseUrl}/ideogram-v3/generate`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Api-Key": getIdeogramApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_request: {
          prompt,
          aspect_ratio: options.aspectRatio ?? "ASPECT_1_1",
          rendering_speed: options.renderingSpeed ?? "DEFAULT",
          num_images: options.destinationPaths.length,
          magic_prompt_option: "AUTO",
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ideogram request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const payload = (await response.json()) as unknown;
    const urls = extractIdeogramUrls(payload);
    if (urls.length === 0) {
      throw new Error("Ideogram did not return any image URLs.");
    }

    await Promise.all(
      options.destinationPaths.map((destinationPath, index) =>
        downloadImageToFile(urls[index] ?? urls[0], destinationPath),
      ),
    );

    logger.action("Ideogram images saved locally", "success", { destinationCount: options.destinationPaths.length });
    return {
      destinationPaths: options.destinationPaths,
      model: "ideogram-v3",
    };
  } catch (error) {
    logger.error("Ideogram image generation failed", error, { promptPreview: prompt.slice(0, 120) });
    throw new Error(`Ideogram image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
