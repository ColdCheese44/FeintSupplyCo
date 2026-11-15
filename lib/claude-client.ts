import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import { createLogger } from "./logger.js";

/**
 * Effort replaces the removed temperature/budget_tokens knobs on Claude 5 models.
 * It controls thinking depth and overall token spend.
 */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

interface ClaudeTextOptions {
  system?: string;
  maxTokens?: number;
  model?: string;
  effort?: ClaudeEffort;
  expectJson?: boolean;
}

export interface ClaudeCompletionResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const logger = createLogger("claude-client");

/** Current production Claude tiers. Exported so the router shares one source of truth. */
export const CLAUDE_QUALITY_MODEL = "claude-opus-5-5";
export const CLAUDE_BALANCED_MODEL = "claude-sonnet-5-5";
export const CLAUDE_LIGHTWEIGHT_MODEL = "claude-haiku-5-5";

const defaultModel = CLAUDE_QUALITY_MODEL;
const fallbackModel = CLAUDE_BALANCED_MODEL;

/**
 * Adaptive thinking is always on for Claude 5 models, and it draws from the same
 * max_tokens budget as the reply. A caller asking for a short answer (prompts here
 * cap length in the prompt text, not via max_tokens) must still leave room for
 * reasoning, or the response comes back truncated or empty.
 */
const MINIMUM_MAX_TOKENS = 4_096;
const DEFAULT_MAX_TOKENS = 16_000;

let anthropicClient: Anthropic | null = null;

/**
 * Maps any legacy Claude identifier to the current supported production model names.
 */
function normalizeClaudeModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return defaultModel;
  }

  const explicitMap: Record<string, string> = {
    // Claude 4.x generation used by earlier FeintSupplyCo revisions.
    "claude-opus-4-6": CLAUDE_QUALITY_MODEL,
    "claude-sonnet-4-6": CLAUDE_BALANCED_MODEL,
    "claude-haiku-4-5": CLAUDE_LIGHTWEIGHT_MODEL,
    "claude-haiku-4-5-20251001": CLAUDE_LIGHTWEIGHT_MODEL,
    "claude-sonnet-4-20250514": CLAUDE_BALANCED_MODEL,
    // Claude 3.x generation.
    "claude-3-opus-20240229": CLAUDE_QUALITY_MODEL,
    "claude-3-sonnet-20240229": CLAUDE_BALANCED_MODEL,
    "claude-3-haiku-20240307": CLAUDE_LIGHTWEIGHT_MODEL,
    "claude-3-5-sonnet-20240620": CLAUDE_BALANCED_MODEL,
    "claude-3-5-sonnet-20241022": CLAUDE_BALANCED_MODEL,
    "claude-3-5-haiku-20241022": CLAUDE_LIGHTWEIGHT_MODEL,
  };

  if (explicitMap[trimmed]) {
    return explicitMap[trimmed];
  }

  // Any other pre-5 identifier maps onto the matching current tier.
  if (/^claude-(3|4)/.test(trimmed)) {
    if (trimmed.includes("haiku")) {
      return CLAUDE_LIGHTWEIGHT_MODEL;
    }
    if (trimmed.includes("opus")) {
      return CLAUDE_QUALITY_MODEL;
    }
    return CLAUDE_BALANCED_MODEL;
  }

  return trimmed;
}

/**
 * Lazily constructs the Anthropic SDK client so credentials are validated only when needed.
 */
function getAnthropicClient(): Anthropic {
  if (anthropicClient) {
    return anthropicClient;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing. Add it to the project .env file before calling Claude.");
  }

  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

/**
 * Extracts plain text from the mixed block content that Anthropic returns, ignoring thinking blocks.
 */
function extractTextFromMessage(content: Anthropic.Messages.Message["content"]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Removes optional Markdown code fences so JSON parsing works against model-friendly responses.
 */
function stripCodeFences(input: string): string {
  return input.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Runs a plain-text prompt against Claude and returns both content and usage metadata.
 */
export async function runClaudeCompletion(prompt: string, options: ClaudeTextOptions = {}): Promise<ClaudeCompletionResult> {
  const client = getAnthropicClient();
  const requestedModel = normalizeClaudeModel(options.model ?? defaultModel);
  const maxTokens = Math.max(options.maxTokens ?? DEFAULT_MAX_TOKENS, MINIMUM_MAX_TOKENS);
  let model = requestedModel;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      logger.action("Sending prompt to Claude", "start", { model, maxTokens });
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: options.system,
        // Adaptive thinking is the only supported mode on Claude 5 models.
        // temperature/top_p/top_k and budget_tokens are rejected with a 400.
        thinking: { type: "adaptive" },
        output_config: { effort: options.effort ?? "medium" },
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        throw new Error(`Claude declined the request (category: ${category}).`);
      }

      const text = extractTextFromMessage(response.content);
      const normalizedText = options.expectJson ? stripCodeFences(text) : text;

      if (!normalizedText) {
        throw new Error(`Claude returned no text content (stop_reason: ${response.stop_reason ?? "unknown"}).`);
      }

      logger.action("Claude response received", "success", {
        characters: normalizedText.length,
        model,
        stopReason: response.stop_reason,
      });
      return {
        text: normalizedText,
        model,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const modelUnavailable = message.includes("not_found_error") || message.includes("model");
      if (attempt === 1 && model === requestedModel && model !== fallbackModel && modelUnavailable) {
        logger.warn("Requested Claude model was unavailable; retrying with fallback tier", {
          requestedModel,
          fallbackModel,
        });
        model = fallbackModel;
        continue;
      }

      logger.error("Claude request failed", error, { promptPreview: prompt.slice(0, 200) });
      throw new Error(`Claude request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Claude request failed: exhausted retry path for requested model ${requestedModel}.`);
}

/**
 * Runs a plain-text prompt against Claude with conservative defaults for automation tasks.
 */
export async function runClaudeText(prompt: string, options: ClaudeTextOptions = {}): Promise<string> {
  const result = await runClaudeCompletion(prompt, options);
  return result.text;
}

/**
 * Runs a prompt and parses the returned JSON payload into a strongly typed object.
 */
export async function runClaudeJson<T>(prompt: string, options: ClaudeTextOptions = {}): Promise<T> {
  const text = (await runClaudeCompletion(prompt, { ...options, expectJson: true })).text;

  try {
    return JSON.parse(stripCodeFences(text)) as T;
  } catch (error) {
    logger.error("Claude returned invalid JSON", error, { response: text });
    throw new Error("Claude returned a response that could not be parsed as JSON.");
  }
}
