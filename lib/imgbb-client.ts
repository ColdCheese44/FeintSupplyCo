import "dotenv/config";

import fs from "node:fs";

import { createLogger } from "./logger.js";

const logger = createLogger("imgbb-client");

/**
 * Returns the configured imgbb API key and fails fast when it is missing.
 */
function getImgbbApiKey(): string {
  const apiKey = process.env.IMGBB_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("IMGBB_API_KEY is missing. Add it to the project .env file before using the POD image upload pipeline.");
  }
  return apiKey;
}

/**
 * Uploads a local image file to imgbb and returns the hosted HTTPS URL.
 */
export async function uploadToImgbb(localImagePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(localImagePath);
  const base64 = fileBuffer.toString("base64");

  const params = new URLSearchParams();
  params.append("key", getImgbbApiKey());
  params.append("image", base64);

  logger.action("Uploading image to imgbb", "start", { localImagePath });
  console.log("Uploading to imgbb...");
  const response = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: params,
  });

  const result = await response.json() as {
    success?: boolean;
    data?: { url?: string };
  };

  if (!response.ok || !result.success || !result.data?.url) {
    console.log("imgbb failed:", JSON.stringify(result));
    throw new Error(`imgbb upload failed: ${JSON.stringify(result)}`);
  }

  logger.action("Uploaded image to imgbb", "success", {
    localImagePath,
    hostedUrl: result.data.url,
  });
  console.log("imgbb URL:", result.data.url);
  return result.data.url;
}
