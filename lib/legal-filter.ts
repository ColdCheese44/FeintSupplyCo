import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { auditLog } from "./audit.js";
import { getDatabase, resolveProjectPath } from "./db.js";
import { createLogger } from "./logger.js";

export type LegalDecision = "allow" | "reject" | "manual_review";
export type LegalFilterMode = "theme" | "copy";

export interface LegalFilterInput {
  theme?: string;
  title?: string;
  description?: string;
  tags?: string[];
  prompt?: string;
  realPersonFlag?: boolean;
  source: string;
}

export interface LegalFilterResult {
  decision: LegalDecision;
  approved: boolean;
  requiresManualReview: boolean;
  reasons: string[];
  matchedTerms: string[];
  normalizedSubject: string;
}

interface PublicFigureEntry {
  name: string;
  context: string;
}

interface LegalAuditEntry {
  timestamp: string;
  source: string;
  decision: LegalDecision;
  subject: string;
  reasons: string[];
  matchedTerms: string[];
}

const logger = createLogger("legal-filter");
const blockedTermsPath = resolveProjectPath("data/legal/blocked-terms.json");
const blockedCharactersPath = resolveProjectPath("data/legal/blocked-characters.json");
const publicFiguresPath = resolveProjectPath("data/legal/public-figures.json");
const auditLogPath = resolveProjectPath("data/legal/legal-filter-log.json");
const ALWAYS_ALLOW = [
  "Feint Supply",
  "Feint Supply Co",
  "Feint Supply Co.",
  "The Feint Supply",
  "Feint",
  "FSC",
  "Signal over noise",
  "Built different",
  "Operator",
  "Operations",
  "The Operator",
  "Quiet Professional",
  "After Action",
  "Field Notes",
  "Signal and Noise",
  "Dark Humor",
  "Investigator",
  "SOC",
  "Cybersecurity",
  "Veteran",
  "Digital Sticker Pack",
  "Sticker Pack",
  "Operations Collection",
  "Supply Collection",
];
const copyModePassthroughTerms = new Set([
  "t-shirt",
  "tee",
  "sticker",
  "sticker pack",
  "poster",
  "print",
  "mug",
  "collection",
  "bundle",
  "digital download",
  "wall art",
  "art print",
  "graphic tee",
  "unisex tee",
]);
const nonPersonVocabulary = new Set([
  "veteran",
  "culture",
  "operator",
  "operations",
  "quiet",
  "professional",
  "after",
  "action",
  "field",
  "notes",
  "signal",
  "noise",
  "dark",
  "humor",
  "investigator",
  "cybersecurity",
  "digital",
  "sticker",
  "pack",
  "collection",
  "supply",
  "special",
  "bundle",
]);
const companyTermPassthrough = new Set([
  "entergy",
  "energy",
  "cps",
  "pge",
  "sce",
  "pseg",
  "nrg",
  "dte",
  "dominion",
  "xcel",
  "ameren",
  "firstenergy",
  "corp",
  "inc",
  "llc",
  "co",
  "group",
  "systems",
  "solutions",
  "technologies",
  "services",
  "associates",
  "partners",
  "enterprise",
  "digital",
  "global",
  "national",
  "media",
  "network",
]);
const genericTermsPassthrough = new Set([
  "coen brothers",
  "coen",
  "brothers",
  "old men",
  "no country",
]);

const celebrityManualReviewList = new Set([
  "taylor swift",
  "beyonce",
  "rihanna",
  "drake",
  "michael jordan",
  "lebron james",
  "kobe bryant",
  "tom brady",
  "travis kelce",
  "lionel messi",
  "cristiano ronaldo",
  "selena gomez",
  "zendaya",
  "kim kardashian",
  "elon musk",
  "oprah winfrey",
]);

const protectedClassTerms = [
  "black",
  "white",
  "asian",
  "latino",
  "gay",
  "lesbian",
  "trans",
  "transgender",
  "muslim",
  "christian",
  "jewish",
  "woman",
  "women",
  "man",
  "men",
];

let cachedBlockedTerms: string[] | null = null;
let cachedBlockedCharacters: string[] | null = null;
let cachedPublicFigures: PublicFigureEntry[] | null = null;

/**
 * Loads a JSON array of strings from disk once so every legal check stays cheap at runtime.
 */
async function loadStringArray(filePath: string, cache: string[] | null): Promise<string[]> {
  if (cache) {
    return cache;
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${filePath}.`);
  }
  return parsed.map((item) => String(item));
}

/**
 * Returns the curated list of safe political figures that can pass the public-capacity real-person gate.
 */
async function loadPublicFigures(): Promise<PublicFigureEntry[]> {
  if (cachedPublicFigures) {
    return cachedPublicFigures;
  }

  const parsed = JSON.parse(await readFile(publicFiguresPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${publicFiguresPath}.`);
  }

  cachedPublicFigures = parsed.map((item) => ({
    name: String((item as PublicFigureEntry).name),
    context: String((item as PublicFigureEntry).context ?? "political"),
  }));
  return cachedPublicFigures;
}

/**
 * Normalizes text into a single lowercase comparison surface for substring and phrase matching.
 */
function buildSubject(input: LegalFilterInput): string {
  const parts = [
    input.theme ?? "",
    input.title ?? "",
    input.description ?? "",
    input.prompt ?? "",
    ...(input.tags ?? []),
  ];

  // Dedupe identical field values (callers frequently pass the same string as both
  // theme and prompt). Without this, the concatenated subject repeats the phrase and
  // the name-candidate anti-repetition guards discard real names, silently disabling
  // the real-person and celebrity gates.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(trimmed);
  }

  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Returns whether a term appears as a whole phrase inside normalized text.
 */
function includesTerm(subject: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped.toLowerCase()}([^a-z0-9]|$)`, "i");
  return pattern.test(subject);
}

/**
 * Returns whether a term is explicitly whitelisted and must never trigger a block on its own.
 */
function isAlwaysAllowedTerm(term: string): boolean {
  const lowered = term.trim().toLowerCase();
  return ALWAYS_ALLOW.some((value) => value.toLowerCase() === lowered);
}

/**
 * Returns whether a term should be ignored in copy mode because it is a generic product-type or catalog label.
 */
function isCopyModePassthroughTerm(term: string): boolean {
  return copyModePassthroughTerms.has(term.trim().toLowerCase());
}

/**
 * Detects likely full-name references so publicity-rights handling can branch before any design is generated.
 */
function extractFullNameCandidates(subject: string): string[] {
  const matches = subject.match(/\b(?:[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){1,2})\b/g) ?? [];
  return [...new Set(matches.filter((match) => {
    const loweredMatch = match.toLowerCase();
    if (match.length < 8 || !match.includes(" ") || genericTermsPassthrough.has(loweredMatch)) {
      return false;
    }

    const words = loweredMatch.split(/\s+/).filter(Boolean);
    const uniqueWords = [...new Set(words)];
    if (uniqueWords.length === 1) {
      return false;
    }
    if (words.length === 2 && words[0] === words[1]) {
      return false;
    }
    if (words.length >= 3 && words[0] === words[words.length - 1]) {
      return false;
    }
    if (uniqueWords.every((word) => companyTermPassthrough.has(word))) {
      return false;
    }
    if (words.length === 2 && (companyTermPassthrough.has(words[0]) || companyTermPassthrough.has(words[1]))) {
      return false;
    }
    if (words.some((word) => nonPersonVocabulary.has(word))) {
      return false;
    }

    return true;
  }))];
}

/**
 * Returns whether a candidate phrase is structured like a real personal name (Title-cased
 * given and family words) rather than a generic design theme such as "retro arcade typography".
 *
 * The speculative real-person gate cannot reliably tell an arbitrary multi-word phrase apart
 * from a name, so this keeps it from rejecting ordinary lowercase or descriptive themes while
 * still catching proper-noun names. Curated celebrity, public-figure, blocked-term, and
 * trademark checks remain the primary defenses for known real people.
 */
function looksLikeProperName(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) {
    return false;
  }
  return words.every((word) => /^[A-Z]/.test(word) && /[a-z]/.test(word));
}

/**
 * Flags potentially discriminatory content when protected-class references are used in hostile contexts.
 */
function detectProtectedClassTargeting(subject: string): string[] {
  const lowered = subject.toLowerCase();
  const matchedPhrases = new Set<string>();

  const hateSpeechPatterns = [
    /\bhate\s+(?:speech|crime|crimes|group)\b/gi,
    /\bhate\s+(?:black|white|asian|latino|gay|lesbian|trans|transgender|muslim|christian|jewish)\s+(?:people|group)\b/gi,
    /\b(?:kill|exterminate|eradicate|remove|banish)\s+(?:all\s+)?(?:black|white|asian|latino|gay|lesbian|trans|transgender|muslim|christian|jewish|women|men)\b/gi,
  ];

  for (const pattern of hateSpeechPatterns) {
    const matches = lowered.match(pattern) ?? [];
    for (const match of matches) {
      if (match.trim().split(/\s+/).length >= 3) {
        matchedPhrases.add(match.trim());
      }
    }
  }

  if (matchedPhrases.size > 0) {
    return [...matchedPhrases];
  }

  if (!protectedClassTerms.some((term) => lowered.includes(term))) {
    return [];
  }

  return [];
}

/**
 * Cross-references locally stored trademark research for active Class 25 marks that should block publishing.
 */
function findBlockedTrademarkMatches(subject: string): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT mark_text, status_code, nice_class
    FROM trademark_candidates
    WHERE nice_class LIKE '%25%'
      AND status_code NOT IN ('602', '606', '710', '800')
  `).all() as Array<{ mark_text: string; status_code: string; nice_class: string }>;

  return rows
    .map((row) => row.mark_text)
    .filter((markText) => markText && includesTerm(subject, markText));
}

/**
 * Appends a legal audit record whenever content is blocked or flagged so governance decisions remain reviewable.
 */
async function appendAuditEntry(entry: LegalAuditEntry): Promise<void> {
  await mkdir(resolveProjectPath("data/legal"), { recursive: true });
  let current: LegalAuditEntry[] = [];
  try {
    const parsed = JSON.parse(await readFile(auditLogPath, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      current = parsed as LegalAuditEntry[];
    }
  } catch {
    current = [];
  }

  current.push(entry);
  await writeFile(auditLogPath, `${JSON.stringify(current.slice(-500), null, 2)}\n`, "utf8");
}

/**
 * Loads the static legal blocklists and caches them in memory for the current process.
 */
async function loadLegalSources(): Promise<{
  blockedTerms: string[];
  blockedCharacters: string[];
  publicFigures: PublicFigureEntry[];
}> {
  cachedBlockedTerms = await loadStringArray(blockedTermsPath, cachedBlockedTerms);
  cachedBlockedCharacters = await loadStringArray(blockedCharactersPath, cachedBlockedCharacters);
  const publicFigures = await loadPublicFigures();

  return {
    blockedTerms: cachedBlockedTerms,
    blockedCharacters: cachedBlockedCharacters,
    publicFigures,
  };
}

/**
 * Evaluates one design or listing payload against Jarvis legal policy and returns a blocking or manual-review decision.
 */
export async function evaluateLegalFilter(input: LegalFilterInput, mode: LegalFilterMode = "theme"): Promise<LegalFilterResult> {
  const subject = buildSubject(input);
  const loweredSubject = subject.toLowerCase();
  const reasons: string[] = [];
  const matchedTerms = new Set<string>();
  const { blockedTerms, blockedCharacters, publicFigures } = await loadLegalSources();

  for (const term of blockedTerms) {
    if (isAlwaysAllowedTerm(term) || (mode === "copy" && isCopyModePassthroughTerm(term))) {
      continue;
    }
    if (includesTerm(loweredSubject, term.toLowerCase())) {
      matchedTerms.add(term);
      reasons.push(`Blocked trademark, sports, or licensed property term: ${term}`);
    }
  }

  for (const character of blockedCharacters) {
    if (isAlwaysAllowedTerm(character)) {
      continue;
    }
    if (includesTerm(loweredSubject, character.toLowerCase())) {
      matchedTerms.add(character);
      reasons.push(`Blocked character or copyrighted fictional property: ${character}`);
    }
  }

  for (const term of findBlockedTrademarkMatches(subject)) {
    if (isAlwaysAllowedTerm(term)) {
      continue;
    }
    matchedTerms.add(term);
    reasons.push(`Blocked active apparel trademark from trademark database: ${term}`);
  }

  const hatefulTerms = detectProtectedClassTargeting(subject);
  if (mode === "theme" && hatefulTerms.length > 0) {
    reasons.push(`Potential hate or protected-class targeting context detected: ${hatefulTerms.join(", ")}`);
  }

  if (mode === "theme") {
    const fullNameCandidates = extractFullNameCandidates(subject);
    const politicalNames = new Set(publicFigures.map((entry) => entry.name.toLowerCase()));
    for (const fullName of fullNameCandidates) {
      const loweredName = fullName.toLowerCase();
      if (genericTermsPassthrough.has(loweredName) || isAlwaysAllowedTerm(fullName)) {
        continue;
      }
      if (politicalNames.has(loweredName)) {
        continue;
      }

      if (celebrityManualReviewList.has(loweredName)) {
        reasons.push(`Celebrity or athlete likeness requires manual review: ${fullName}`);
        matchedTerms.add(fullName);
        const result: LegalFilterResult = {
          decision: "manual_review",
          approved: false,
          requiresManualReview: true,
          reasons,
          matchedTerms: [...matchedTerms],
          normalizedSubject: subject,
        };
        await appendAuditEntry({
          timestamp: new Date().toISOString(),
          source: input.source,
          decision: result.decision,
          subject,
          reasons,
          matchedTerms: result.matchedTerms,
        });
        return result;
      }

      if (!looksLikeProperName(fullName)) {
        continue;
      }

      reasons.push(`Private individual or unsupported real-person reference rejected: ${fullName}`);
      matchedTerms.add(fullName);
    }
  }

  if (mode === "copy") {
    for (const allowedTerm of ALWAYS_ALLOW) {
      if (includesTerm(loweredSubject, allowedTerm.toLowerCase())) {
        continue;
      }
    }
  }

  if (reasons.length > 0) {
    const result: LegalFilterResult = {
      decision: "reject",
      approved: false,
      requiresManualReview: false,
      reasons,
      matchedTerms: [...matchedTerms],
      normalizedSubject: subject,
    };
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      source: input.source,
      decision: result.decision,
      subject,
      reasons,
      matchedTerms: result.matchedTerms,
    });
    auditLog("reject_legal", "system", {
      source: input.source,
      subject,
      reasons,
      matchedTerms: result.matchedTerms,
    });
    return result;
  }

  return {
    decision: "allow",
    approved: true,
    requiresManualReview: false,
    reasons: [],
    matchedTerms: [],
    normalizedSubject: subject,
  };
}

/**
 * Throws a blocking error when content fails the legal gate so callers can stop before spending money or publishing.
 */
export async function assertLegalApproval(
  content: string | LegalFilterInput,
  mode: LegalFilterMode = "theme",
  trusted = false,
): Promise<LegalFilterResult> {
  if (trusted) {
    logger.debug("Legal filter bypassed: trusted source", { mode });
    return {
      decision: "allow",
      approved: true,
      requiresManualReview: false,
      reasons: [],
      matchedTerms: [],
      normalizedSubject: typeof content === "string" ? content : buildSubject(content),
    };
  }

  const normalizedInput: LegalFilterInput = typeof content === "string"
    ? {
      theme: mode === "theme" ? content : undefined,
      title: mode === "copy" ? content : undefined,
      description: mode === "copy" ? content : undefined,
      source: "trusted-flex-call",
    }
    : content;

  const result = await evaluateLegalFilter(normalizedInput, mode);
  if (!result.approved) {
    logger.warn("Legal filter blocked Jarvis content", {
      source: normalizedInput.source,
      decision: result.decision,
      reasons: result.reasons,
      matchedTerms: result.matchedTerms,
    });
    throw new Error(`Legal filter ${result.decision}: ${result.reasons.join(" | ")}`);
  }
  return result;
}

/**
 * Ensures every listing description includes the required AI assistance disclosure sentence exactly once.
 */
export function appendAiDisclosure(description: string): string {
  const disclosure = "This design was created with the assistance of AI image generation tools.";
  if (description.includes(disclosure)) {
    return description;
  }
  return `${description.trim()}\n\n${disclosure}`;
}
