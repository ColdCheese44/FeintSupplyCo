import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  createTrademarkCandidate,
  initializeDatabase,
  listTrademarkCandidatesAboveThreshold,
  resolveProjectPath,
} from "../lib/db.js";
import { postDiscord } from "../lib/discord.js";
import { searchActiveListings } from "../lib/etsy-client.js";
import { callLLM } from "../lib/llm-router.js";
import { createLogger } from "../lib/logger.js";
import { searchRedditPosts } from "../lib/reddit-client.js";
import { isDryRunEnabled } from "../lib/runtime.js";
import { fetchTrademarkCaseDetails, searchTrademarkCases, type UsptoTrademarkCase } from "../lib/uspto-client.js";

export interface TrademarkHunterSummary {
  reviewed: number;
  created: number;
  alerted: number;
  failures: string[];
}

export interface TrademarkSelfTestResult {
  label: string;
  serial: string;
  success: boolean;
  note: string;
}

export interface TrademarkSelfTestSummary {
  passed: number;
  failed: number;
  results: TrademarkSelfTestResult[];
}

const logger = createLogger("trademark-hunter");
const alertThreshold = Number.parseFloat(process.env.TRADEMARK_REVIEW_THRESHOLD ?? "0.7");
const nostalgiaSubreddits = ["nostalgia", "80s", "90s", "2000s"];
const controlSerials = [
  { label: "Coca-Cola", serial: "71016321" },
  { label: "Apple", serial: "73558960" },
  { label: "Disney", serial: "73265465" },
];

/**
 * Converts provider case data into a stable dossier file name.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Applies a small legal-cleanliness bonus based on the underlying USPTO status code.
 */
function getStatusBonus(statusCode: string): number {
  if (statusCode === "800" || statusCode === "710") {
    return 0.2;
  }
  if (statusCode === "602" || statusCode === "606") {
    return 0.1;
  }
  return 0;
}

/**
 * Estimates cultural relevance from recent Reddit mentions inside nostalgia-heavy communities.
 */
async function scoreRecognition(markText: string): Promise<number> {
  const posts = await searchRedditPosts(markText, nostalgiaSubreddits, 10);
  const totalSignal = posts.reduce((sum, post) => sum + post.score + post.num_comments, 0);
  return Math.min(totalSignal / 500, 1);
}

/**
 * Estimates common-law use by looking for active Etsy sellers already using the term.
 */
async function scoreLegalCleanliness(markText: string, statusCode: string): Promise<number> {
  const listings = await searchActiveListings(markText, 20);
  const commonLawUseScore = Math.min(listings.length / 20, 1);
  return Math.max(0, Math.min(1, 1 - commonLawUseScore + getStatusBonus(statusCode)));
}

/**
 * Builds the natural-language dossier body that will be written into the candidate PDF.
 */
async function buildDossierNarrative(caseRecord: UsptoTrademarkCase, recognitionScore: number, legalCleanlinessScore: number): Promise<string> {
  const prompt = `Write a cautious trademark research dossier for human review. The output must explicitly warn that no product should be produced or filed automatically. Summarize the mark status, last known owner, apparent cultural relevance, and common-law-use risk in plain English.

Mark text: ${caseRecord.mark_text ?? "Unknown"}
Registration number: ${caseRecord.registration_number ?? "Unknown"}
Status code: ${caseRecord.status_code ?? "Unknown"}
Status: ${caseRecord.status ?? "Unknown"}
Abandonment date: ${caseRecord.abandonment_date ?? "Unknown"}
Last owner: ${caseRecord.last_owner ?? "Unknown"}
Nice class: ${caseRecord.nice_class ?? "Unknown"}
Goods/services: ${caseRecord.goods_services ?? "Unknown"}
Recognition score: ${recognitionScore.toFixed(2)}
Legal cleanliness score: ${legalCleanlinessScore.toFixed(2)}
`;

  const result = await callLLM({
    taskType: "trademark_dossier_writing",
    prompt,
    maxTokens: 900,
  });
  return result.text ?? "";
}

/**
 * Generates a simple PDF dossier so candidates can be reviewed asynchronously outside the terminal.
 */
async function createDossierPdf(markText: string, narrative: string): Promise<string> {
  const directory = resolveProjectPath("data/trademark_candidates");
  await mkdir(directory, { recursive: true });
  const filePath = resolve(directory, `${slugify(markText)}.pdf`);

  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  let cursorY = 760;

  page.drawText(`FeintSupplyCo Trademark Review: ${markText}`, {
    x: 48,
    y: cursorY,
    size: 18,
    font,
    color: rgb(0.08, 0.08, 0.08),
  });
  cursorY -= 30;

  for (const line of narrative.split(/\n+/)) {
    const wrappedLine = line.trim();
    if (!wrappedLine) {
      cursorY -= 8;
      continue;
    }

    page.drawText(wrappedLine.slice(0, 95), {
      x: 48,
      y: cursorY,
      size: fontSize,
      font,
      color: rgb(0.15, 0.15, 0.15),
    });
    cursorY -= 18;
    if (cursorY < 60) {
      cursorY = 760;
      document.addPage([612, 792]);
    }
  }

  await writeFile(filePath, await document.save());
  return filePath;
}

/**
 * Posts a Discord alert when a trademark candidate crosses the configured review threshold.
 */
async function postTrademarkAlert(candidateId: number, markText: string, combinedScore: number, dossierPath: string): Promise<void> {
  await postDiscord("legal", {
    embeds: [
      {
        title: "Trademark Review Candidate",
        description: "A trademark candidate exceeded the review threshold and needs human review only.",
        color: 0xffb000,
        fields: [
          { name: "Candidate", value: markText, inline: true },
          { name: "Score", value: combinedScore.toFixed(2), inline: true },
          { name: "Candidate ID", value: String(candidateId), inline: true },
          { name: "Dossier", value: dossierPath, inline: false },
        ],
      },
    ],
  });
}

/**
 * Validates that a fetched USPTO case contains enough structured fields to count as parseable for self-test use.
 */
function caseLooksParseable(caseRecord: UsptoTrademarkCase | null): boolean {
  if (!caseRecord) {
    return false;
  }

  return Boolean(
    (caseRecord.mark_text && caseRecord.mark_text.trim())
    || (caseRecord.status && caseRecord.status.trim())
    || (caseRecord.status_code && caseRecord.status_code.trim())
    || (caseRecord.registration_number && caseRecord.registration_number.trim()),
  );
}

/**
 * Runs the USPTO control-case self-test without creating dossiers or touching human-review candidate state.
 */
export async function runTrademarkSelfTest(): Promise<TrademarkSelfTestSummary> {
  const results: TrademarkSelfTestResult[] = [];

  for (const control of controlSerials) {
    try {
      const caseRecord = await fetchTrademarkCaseDetails(control.serial);
      const success = caseLooksParseable(caseRecord);
      results.push({
        label: control.label,
        serial: control.serial,
        success,
        note: success
          ? `Parsed mark "${caseRecord?.mark_text ?? "unknown"}" with status ${caseRecord?.status_code ?? caseRecord?.status ?? "unknown"}.`
          : "USPTO returned a response, but the case status payload was not parseable.",
      });
    } catch (error) {
      results.push({
        label: control.label,
        serial: control.serial,
        success: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary: TrademarkSelfTestSummary = {
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    results,
  };
  logger.action("Trademark self-test completed", "success", summary);
  return summary;
}

/**
 * Runs the trademark review workflow and stores only human-review dossiers without ever producing products.
 */
export async function runTrademarkHunter(): Promise<TrademarkHunterSummary> {
  if (isDryRunEnabled()) {
    const summary: TrademarkHunterSummary = {
      reviewed: 1,
      created: 1,
      alerted: 0,
      failures: [],
    };
    logger.action("Dry-run trademark hunter completed", "skip", summary);
    return summary;
  }

  initializeDatabase();
  const summary: TrademarkHunterSummary = {
    reviewed: 0,
    created: 0,
    alerted: 0,
    failures: [],
  };

  logger.action("Starting trademark hunter", "start", { alertThreshold });
  const candidates = await searchTrademarkCases({
    statusCodes: ["602", "606", "710", "800"],
    niceClasses: ["25", "9"],
    limit: 20,
  });

  for (const candidate of candidates) {
    if (!candidate.mark_text) {
      continue;
    }

    summary.reviewed += 1;

    try {
      const detailedCase =
        (candidate.serial_number ? await fetchTrademarkCaseDetails(candidate.serial_number) : null) ??
        (candidate.registration_number ? await fetchTrademarkCaseDetails(candidate.registration_number) : null) ??
        candidate;

      const recognitionScore = await scoreRecognition(candidate.mark_text);
      const legalCleanlinessScore = await scoreLegalCleanliness(candidate.mark_text, candidate.status_code ?? "000");
      const narrative = await buildDossierNarrative(detailedCase, recognitionScore, legalCleanlinessScore);
      const dossierPath = await createDossierPdf(candidate.mark_text, narrative);
      const created = createTrademarkCandidate({
        markText: candidate.mark_text,
        registrationNumber: candidate.registration_number ?? null,
        statusCode: candidate.status_code ?? "unknown",
        abandonmentDate: candidate.abandonment_date ?? null,
        lastOwner: candidate.last_owner ?? null,
        niceClass: candidate.nice_class ?? "unknown",
        recognitionScore,
        legalCleanlinessScore,
        dossierPath,
        reviewedByHuman: false,
        metadata: {
          status: detailedCase.status ?? null,
          goodsServices: detailedCase.goods_services ?? null,
          note: "Human review only. FeintSupplyCo must never auto-produce or auto-file from trademark candidates.",
        },
      });
      summary.created += 1;

      const combinedScore = (recognitionScore + legalCleanlinessScore) / 2;
      if (combinedScore >= alertThreshold) {
        await postTrademarkAlert(created.id, candidate.mark_text, combinedScore, dossierPath);
        summary.alerted += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failures.push(message);
      logger.error("Failed to process a trademark candidate", error, { markText: candidate.mark_text });
    }
  }

  const alertCandidates = listTrademarkCandidatesAboveThreshold(alertThreshold);
  logger.action("Completed trademark hunter", "success", {
    ...summary,
    highPriorityCandidates: alertCandidates.length,
  });
  return summary;
}

/**
 * Detects whether this module is being run directly so the CLI entry point stays optional.
 */
function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs the standalone trademark-hunter entry point and supports the control-case self-test flag.
 */
async function main(): Promise<void> {
  try {
    if (process.argv.includes("--self-test")) {
      const summary = await runTrademarkSelfTest();
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = summary.failed > 0 ? 1 : 0;
      return;
    }

    const summary = await runTrademarkHunter();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    logger.error("Standalone trademark-hunter execution failed", error);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  await main();
}
