import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import { createLogger } from "./logger.js";

interface ClaudeTextOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  expectJson?: boolean;
}

export interface ClaudeCompletionResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const logger = createLogger("claude-client");
const defaultModel = "claude-sonnet-4-6";
const lightweightModel = "claude-haiku-4-5-20251001";
const fallbackModel = "claude-sonnet-4-6";
let anthropicClient: Anthropic | null = null;

/**
 * Maps any legacy Claude identifier to the current supported production model names.
 */
function normalizeClaudeModel(model: string): string {
  const trimmed = model.trim();
  const explicitMap: Record<string, string> = {
    "claude-3-opus-20240229": "claude-opus-4-6",
    "claude-3-sonnet-20240229": "claude-sonnet-4-6",
    "claude-3-haiku-20240307": "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20240620": "claude-sonnet-4-6",
    "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
    "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  };

  if (explicitMap[trimmed]) {
    return explicitMap[trimmed];
  }

  if (trimmed.startsWith("claude-3")) {
    if (trimmed.includes("haiku")) {
      return lightweightModel;
    }
    if (trimmed.includes("opus")) {
      return "claude-opus-4-6";
    }
    return "claude-sonnet-4-6";
  }

  return trimmed || defaultModel;
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
 * Extracts plain text from the mixed block content that Anthropic returns.
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
  let model = requestedModel;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      logger.action("Sending prompt to Claude", "start", { model });
      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 1_024,
        temperature: options.temperature ?? 0.4,
        system: options.system,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const text = extractTextFromMessage(response.content);
      const normalizedText = options.expectJson ? stripCodeFences(text) : text;
      logger.action("Claude response received", "success", { characters: normalizedText.length, model });
      return {
        text: normalizedText,
        model,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (attempt === 1 && model === requestedModel && model !== fallbackModel && message.includes("not_found_error")) {
        logger.warn("Requested Claude model was unavailable; retrying with fallback snapshot", {
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
  const text = (await runClaudeCompletion(prompt, options)).text;

  try {
    return JSON.parse(stripCodeFences(text)) as T;
  } catch (error) {
    logger.error("Claude returned invalid JSON", error, { response: text });
    throw new Error("Claude returned a response that could not be parsed as JSON.");
  }
}
