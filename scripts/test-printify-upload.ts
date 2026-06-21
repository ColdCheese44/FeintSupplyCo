import "dotenv/config";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../lib/logger.js";
import { resolveProjectPath } from "../lib/db.js";

const logger = createLogger("test-printify-upload");

/**
 * Recursively returns the first PNG file found under the provided directory.
 */
async function findFirstPng(directoryPath: string): Promise<string | null> {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstPng(fullPath);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Runs the direct Printify upload probe against a real local design file and prints the full provider response.
 */
async function main(): Promise<void> {
  const token = process.env.PRINTIFY_API_TOKEN?.trim();
  if (!token) {
    throw new Error("PRINTIFY_API_TOKEN is missing. Add it to the project .env file before running this diagnostic.");
  }

  const designsRoot = resolveProjectPath("data/designs");
  const pngPath = await findFirstPng(designsRoot);
  if (!pngPath) {
    throw new Error(`No .png file was found under ${designsRoot}. Generate at least one design first.`);
  }

  const fileBuffer = await readFile(pngPath);
  const base64Contents = fileBuffer.toString("base64");

  logger.action("Testing Printify upload endpoint", "start", {
    pngPath,
    byteLength: fileBuffer.byteLength,
  });

  const response = await fetch("https://api.printify.com/v1/uploads/images.json", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_name: "test.png",
      contents: base64Contents,
    }),
  });

  const responseText = await response.text();
  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log("Body:");
  console.log(responseText);

  if (response.ok) {
    let parsed: { id?: string } = {};
    try {
      parsed = JSON.parse(responseText) as { id?: string };
    } catch {
      parsed = {};
    }
    console.log(`Upload succeeded. Image ID: ${parsed.id ?? "unknown"}`);
    return;
  }

  if (response.status === 403) {
    console.log("403 may indicate upload scope not granted or Printify plan restriction. Check:");
    console.log("1. Token has uploads:write scope");
    console.log("2. Printify account plan supports API uploads");
    console.log("3. Shop is properly connected");
  }
}

try {
  await main();
} catch (error) {
  logger.error("Printify upload diagnostic failed", error);
  process.exitCode = 1;
}
