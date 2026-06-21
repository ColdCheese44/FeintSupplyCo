import "dotenv/config";

import { pathToFileURL } from "node:url";

import { generatePosterDesign } from "../lib/brand-compositor.js";
import { runDeterministicCollection, type CollectionScriptOptions, type DeterministicCollectionConfig } from "./generate-branded-collection.js";

const config: DeterministicCollectionConfig<{ id: number; outputPath: string }> = {
  productType: "poster",
  loggerName: "generate-poster-collection",
  rootDirectory: "data/posters",
  reportPath: "data/posters/poster-collection-report.json",
  preferredNicheNames: [
    "Minimal Dark Aesthetic",
    "Cybersecurity Culture",
    "Cold War Intelligence",
    "Quiet Professional",
  ],
  defaultTags: [
    "feint supply",
    "veteran poster",
    "cyber wall art",
    "quiet professional",
    "dark wall art",
    "office decor",
    "made to order",
    "minimal poster",
    "operator decor",
  ],
  designs: [
    { id: 1, name: "Signal Over Noise", concept: "portrait poster built around signal-over-noise typography and dark precision", sectionTitle: "Cybersecurity & Tech" },
    { id: 2, name: "Quiet Professional", concept: "minimal quiet professional wall art with measured authority and low-noise styling", sectionTitle: "Veteran Culture" },
    { id: 3, name: "Grid Dossier", concept: "high-detail grid dossier poster with coordinates and investigation-board discipline", sectionTitle: "Cybersecurity & Tech" },
    { id: 4, name: "Terminal Bulletin", concept: "terminal bulletin poster with operational status language and green-screen clarity", sectionTitle: "Cybersecurity & Tech" },
    { id: 5, name: "Chevron Hero", concept: "hero poster with amber chevron focus and veteran-owned brand posture", sectionTitle: "Veteran Culture" },
    { id: 6, name: "Operationally Sound", concept: "typographic dark-humor poster balancing operational competence and restrained sarcasm", sectionTitle: "Veteran Culture" },
  ],
  generateDesign: generatePosterDesign,
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
