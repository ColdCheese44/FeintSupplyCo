import fs from "node:fs";
import path from "node:path";

import { uploadFile } from "../lib/printful-client.js";

async function main(): Promise<void> {
  const stickersDir = "./data/stickers/1";
  const designsDir = "./data/designs";

  let testPng: string | null = null;

  if (fs.existsSync(`${stickersDir}/design.png`)) {
    testPng = `${stickersDir}/design.png`;
  } else if (fs.existsSync(designsDir)) {
    const dirs = fs.readdirSync(designsDir);
    for (const dir of dirs) {
      const candidate = path.join(designsDir, dir, "design.png");
      if (fs.existsSync(candidate)) {
        testPng = candidate;
        break;
      }
    }
  }

  if (!testPng) {
    console.log("No test PNG found in data/stickers or data/designs");
    process.exit(1);
  }

  console.log(`Testing with: ${testPng}`);
  console.log("Step 1: Uploading to imgbb...");

  try {
    const result = await uploadFile(testPng, "test-design.png");
    console.log("SUCCESS");
    console.log("Printful file ID:", result.id);
    console.log("Printful file URL:", result.url);
  } catch (err) {
    console.log("FAILED");
    console.log(err instanceof Error ? err.message : err);
  }
}

await main();
