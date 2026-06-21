import "dotenv/config";

import { pathToFileURL } from "node:url";

import { generateHoodieDesign } from "../lib/brand-compositor.js";
import { runDeterministicCollection, type CollectionScriptOptions, type DeterministicCollectionConfig } from "./generate-branded-collection.js";

const config: DeterministicCollectionConfig<{ id: number; outputPath: string }> = {
  productType: "hoodie",
  loggerName: "generate-hoodie-collection",
  rootDirectory: "data/hoodies",
  reportPath: "data/hoodies/hoodie-collection-report.json",
  preferredNicheNames: [
    "Veteran Owned Brand",
    "Cybersecurity Culture",
    "Quiet Professional",
    "Tech Veteran Crossover",
  ],
  defaultTags: [
    "feint supply",
    "veteran hoodie",
    "cyber hoodie",
    "operator hoodie",
    "dark aesthetic",
    "graphic hoodie",
    "quiet professional",
    "made to order",
    "streetwear",
  ],
  designs: [
    { id: 1, name: "Signal Wordmark", concept: "hoodie chest print with FEINT SUPPLY CO. wordmark and signal-over-noise clarity", sectionTitle: "Veteran Culture" },
    { id: 2, name: "Redacted", concept: "classified hoodie graphic with investigator energy and stripped-down dark humor", sectionTitle: "Veteran Culture" },
    { id: 3, name: "Operationally Sound", concept: "hoodie typography balancing competence, sarcasm, and low-visibility confidence", sectionTitle: "Veteran Culture" },
    { id: 4, name: "Terminal Status", concept: "hoodie front graphic with terminal status language and clean green-screen cues", sectionTitle: "Cybersecurity & Tech" },
    { id: 5, name: "Chevron Mark", concept: "hoodie chest print with a bold amber chevron and understated back-up signal energy", sectionTitle: "Veteran Culture" },
    { id: 6, name: "After Action", concept: "after action report hoodie graphic with restrained field-note humor", sectionTitle: "Veteran Culture" },
  ],
  generateDesign: generateHoodieDesign,
};

function parseCliArgs(argv: string[]): CollectionScriptOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  const result = await runDeterministicCollection(config, parseCliArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution()) {
  await main();
}
