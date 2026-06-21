import "dotenv/config";

import { pathToFileURL } from "node:url";

import { generateMugDesign } from "../lib/brand-compositor.js";
import { runDeterministicCollection, type CollectionScriptOptions, type DeterministicCollectionConfig } from "./generate-branded-collection.js";

const config: DeterministicCollectionConfig<{ id: number; outputPath: string }> = {
  productType: "mug",
  loggerName: "generate-mug-collection",
  rootDirectory: "data/mugs",
  reportPath: "data/mugs/mug-collection-report.json",
  preferredNicheNames: [
    "Veteran Owned Brand",
    "Cybersecurity Culture",
    "Quiet Professional",
    "Minimal Dark Aesthetic",
  ],
  defaultTags: [
    "feint supply",
    "veteran mug",
    "cyber mug",
    "operator gift",
    "coffee mug",
    "quiet professional",
    "dark aesthetic",
    "desk setup",
    "made to order",
  ],
  designs: [
    { id: 1, name: "Signal Wrap", concept: "wrap-around FEINT SUPPLY CO. wordmark with signal-over-noise restraint", sectionTitle: "Veteran Culture" },
    { id: 2, name: "Chevron Brief", concept: "quiet professional mug with amber chevrons and low-profile operator language", sectionTitle: "Veteran Culture" },
    { id: 3, name: "Terminal Status", concept: "terminal-style mug layout with clean green operational status text", sectionTitle: "Cybersecurity & Tech" },
    { id: 4, name: "After Action", concept: "after action report mug with dry humor payoff line", sectionTitle: "Veteran Culture" },
    { id: 5, name: "Grid Mark", concept: "coordinate-grid mug art with cyan crosshairs and an FSC center mark", sectionTitle: "Cybersecurity & Tech" },
    { id: 6, name: "Redacted Wrap", concept: "classified dossier mug with restrained dark humor and investigator energy", sectionTitle: "Veteran Culture" },
  ],
  generateDesign: generateMugDesign,
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
