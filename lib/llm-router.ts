import "dotenv/config";

import { performance } from "node:perf_hooks";

import {
  CLAUDE_BALANCED_MODEL,
  CLAUDE_LIGHTWEIGHT_MODEL,
  CLAUDE_QUALITY_MODEL,
  runClaudeCompletion,
  type ClaudeEffort,
} from "./claude-client.js";
import { recordLlmCall } from "./db.js";
import { generateIdeogramImages } from "./ideogram-client.js";
import { createLogger } from "./logger.js";
import { generateRecraftImages } from "./recraft-client.js";
import { generateReplicateImage } from "./replicate-client.js";

export type LlmTaskType =
  | "listing_copywriting"
  | "product_description_seo"
  | "trend_analysis_reasoning"
  | "photorealistic_mockups"
  | "apparel_design_with_text"
  | "vector_logos"
  | "shop_banner"
  | "bulk_variant_generation"
  | "customer_service_replies"
  | "trademark_dossier_writing";

type ProviderName = "claude" | "ideogram" | "recraft" | "replicate";

interface RouteDefinition {
  provider: ProviderName;
  model: string;
  effort?: ClaudeEffort;
}

export interface CallLlmInput {
  taskType: LlmTaskType;
  prompt: string;
  system?: string;
  destinationPath?: string;
  destinationPaths?: string[];
  effort?: ClaudeEffort;
  maxTokens?: number;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  transparentBackground?: boolean;
  expectJson?: boolean;
}

export interface CallLlmResult {
  provider: ProviderName;
  model: string;
  text?: string;
  destinationPaths?: string[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

const logger = createLogger("llm-router");

const FLUX_SCHNELL_MODEL = "black-forest-labs/flux-schnell";
const SDXL_MODEL = "stability-ai/sdxl";
const IDEOGRAM_MODEL = "ideogram-v3";
const RECRAFT_MODEL = "recraftv4";

/**
 * Returns the configured routing strategy and falls back safely when the env value is invalid.
 */
function getRoutingStrategy(): "cost_optimized" | "quality_first" | "speed_first" {
  const strategy = process.env.LLM_ROUTING_STRATEGY?.trim();
  if (strategy === "quality_first" || strategy === "speed_first" || strategy === "cost_optimized") {
    return strategy;
  }
  return "cost_optimized";
}

/**
 * Picks the Claude tier chain for general text work based on the configured routing strategy.
 * Every tier is Claude; the fallback covers transient per-model failures, not another vendor.
 */
function getClaudeTextRoutes(): RouteDefinition[] {
  switch (getRoutingStrategy()) {
    case "quality_first":
      return [
        { provider: "claude", model: CLAUDE_QUALITY_MODEL, effort: "high" },
        { provider: "claude", model: CLAUDE_BALANCED_MODEL, effort: "high" },
      ];
    case "speed_first":
      return [
        { provider: "claude", model: CLAUDE_LIGHTWEIGHT_MODEL, effort: "low" },
        { provider: "claude", model: CLAUDE_BALANCED_MODEL, effort: "low" },
      ];
    case "cost_optimized":
      return [
        { provider: "claude", model: CLAUDE_BALANCED_MODEL, effort: "medium" },
        { provider: "claude", model: CLAUDE_LIGHTWEIGHT_MODEL, effort: "medium" },
      ];
  }
}

/**
 * Reports whether a provider has a usable credential, so the router can skip routes
 * that would fail on a missing key instead of spending an attempt on them.
 */
function isProviderConfigured(provider: ProviderName): boolean {
  switch (provider) {
    case "claude":
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    case "replicate":
      return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
    case "ideogram":
      return Boolean(process.env.IDEOGRAM_API_KEY?.trim());
    case "recraft":
      return Boolean(process.env.RECRAFT_API_KEY?.trim());
  }
}

/**
 * Builds the ordered provider route list from the project routing policy for the given task type.
 *
 * Text generation is Claude end to end. Image generation stays multi-provider because Claude
 * does not render pixels: Claude authors the art prompt at the callsite, these providers draw it.
 */
function getRouteDefinitions(taskType: LlmTaskType): RouteDefinition[] {
  switch (taskType) {
    case "listing_copywriting":
    case "product_description_seo":
    case "trend_analysis_reasoning":
    case "trademark_dossier_writing":
      return getClaudeTextRoutes();
    case "customer_service_replies":
      return [
        { provider: "claude", model: CLAUDE_LIGHTWEIGHT_MODEL, effort: "low" },
        { provider: "claude", model: CLAUDE_BALANCED_MODEL, effort: "low" },
      ];
    case "photorealistic_mockups":
      return [
        { provider: "replicate", model: FLUX_SCHNELL_MODEL },
        { provider: "replicate", model: SDXL_MODEL },
      ];
    case "apparel_design_with_text":
      return [
        { provider: "ideogram", model: IDEOGRAM_MODEL },
        { provider: "replicate", model: FLUX_SCHNELL_MODEL },
        { provider: "replicate", model: SDXL_MODEL },
      ];
    case "vector_logos":
      return [
        { provider: "recraft", model: RECRAFT_MODEL },
        { provider: "ideogram", model: IDEOGRAM_MODEL },
        { provider: "replicate", model: FLUX_SCHNELL_MODEL },
      ];
    case "shop_banner":
      return [
        { provider: "replicate", model: FLUX_SCHNELL_MODEL },
        { provider: "ideogram", model: IDEOGRAM_MODEL },
        { provider: "replicate", model: SDXL_MODEL },
      ];
    case "bulk_variant_generation":
      return [
        { provider: "replicate", model: FLUX_SCHNELL_MODEL },
        { provider: "replicate", model: SDXL_MODEL },
      ];
  }
}

/**
 * Estimates text-model cost from current published Anthropic per-million-token rates.
 */
function estimateTextCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates: Record<string, { input: number; output: number }> = {
    [CLAUDE_QUALITY_MODEL]: { input: 0.000004, output: 0.00002 },
    [CLAUDE_BALANCED_MODEL]: { input: 0.000002, output: 0.00001 },
    [CLAUDE_LIGHTWEIGHT_MODEL]: { input: 0.0000001, output: 0.0000005 },
  };

  const rate = rates[model] ?? rates[CLAUDE_BALANCED_MODEL];
  return Number(((promptTokens * rate.input) + (completionTokens * rate.output)).toFixed(6));
}

/**
 * Estimates image-model cost conservatively enough to support design budget enforcement.
 */
function estimateImageCost(model: string): number {
  const rates: Record<string, number> = {
    [IDEOGRAM_MODEL]: 0.08,
    [RECRAFT_MODEL]: 0.06,
    [FLUX_SCHNELL_MODEL]: 0.01,
    [SDXL_MODEL]: 0.01,
  };
  return rates[model] ?? 0.05;
}

/**
 * Persists a normalized record of a routed provider call so usage and latency can be analyzed later.
 */
function recordNormalizedCall(result: CallLlmResult, taskType: LlmTaskType, success: boolean, metadata?: unknown): void {
  recordLlmCall({
    taskType,
    model: result.model,
    provider: result.provider,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    success,
    metadata,
  });
}

/**
 * Executes a single provider call attempt and normalizes the output into a common shape for skills.
 */
async function executeRoute(input: CallLlmInput, route: RouteDefinition): Promise<CallLlmResult> {
  const startedAt = performance.now();

  switch (route.provider) {
    case "claude": {
      const response = await runClaudeCompletion(input.prompt, {
        model: route.model,
        system: input.system,
        maxTokens: input.maxTokens,
        effort: input.effort ?? route.effort,
        expectJson: input.expectJson,
      });

      return {
        provider: route.provider,
        model: response.model,
        text: response.text,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        costUsd: estimateTextCost(response.model, response.promptTokens, response.completionTokens),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    case "ideogram": {
      const destinationPaths = input.destinationPaths ?? (input.destinationPath ? [input.destinationPath] : []);
      if (destinationPaths.length === 0) {
        throw new Error(`Task ${input.taskType} requires destinationPath or destinationPaths for image output.`);
      }

      const response = await generateIdeogramImages(input.prompt, {
        destinationPaths,
        transparentBackground: input.transparentBackground,
      });

      return {
        provider: route.provider,
        model: response.model,
        destinationPaths: response.destinationPaths,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimateImageCost(response.model) * response.destinationPaths.length,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    case "recraft": {
      const destinationPaths = input.destinationPaths ?? (input.destinationPath ? [input.destinationPath] : []);
      if (destinationPaths.length === 0) {
        throw new Error(`Task ${input.taskType} requires destinationPath or destinationPaths for image output.`);
      }

      const response = await generateRecraftImages(input.prompt, {
        destinationPaths,
        model: route.model,
        size: input.size,
      });

      return {
        provider: route.provider,
        model: response.model,
        destinationPaths: response.destinationPaths,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimateImageCost(response.model) * response.destinationPaths.length,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    case "replicate": {
      if (!input.destinationPath) {
        throw new Error(`Task ${input.taskType} requires destinationPath for image output.`);
      }

      const response = await generateReplicateImage(input.prompt, {
        model: route.model,
        destinationPath: input.destinationPath,
      });

      return {
        provider: route.provider,
        model: response.model,
        destinationPaths: [response.destinationPath],
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimateImageCost(response.model),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
  }
}

/**
 * Routes a task across the ordered provider chain, recording each failed attempt until one succeeds.
 */
export async function callLLM(input: CallLlmInput): Promise<CallLlmResult> {
  const allRoutes = getRouteDefinitions(input.taskType);
  const routes = allRoutes.filter((route) => isProviderConfigured(route.provider));
  const skipped = allRoutes.filter((route) => !isProviderConfigured(route.provider));

  if (skipped.length > 0) {
    logger.warn("Skipping LLM routes with no configured credential", {
      taskType: input.taskType,
      skipped: skipped.map((route) => `${route.provider}:${route.model}`),
    });
  }

  if (routes.length === 0) {
    const providers = [...new Set(allRoutes.map((route) => route.provider))].join(", ");
    throw new Error(`No configured provider for ${input.taskType}. Add a credential for one of: ${providers}.`);
  }

  logger.action("Routing LLM task", "start", {
    taskType: input.taskType,
    strategy: getRoutingStrategy(),
    routes,
  });

  const errors: string[] = [];

  for (const [index, route] of routes.entries()) {
    try {
      const result = await executeRoute(input, route);
      recordNormalizedCall(result, input.taskType, true, { routeIndex: index });
      logger.action(index === 0 ? "LLM task completed on primary route" : "LLM task completed on fallback route", "success", {
        taskType: input.taskType,
        provider: result.provider,
        model: result.model,
        costUsd: result.costUsd,
        routeIndex: index,
      });
      return result;
    } catch (routeError) {
      const errorMessage = routeError instanceof Error ? routeError.message : String(routeError);
      errors.push(`${route.provider}:${route.model} -> ${errorMessage}`);
      logger.warn(index === 0 ? "Primary LLM route failed; trying fallback" : "Fallback LLM route failed; trying next route", {
        taskType: input.taskType,
        route,
        routeIndex: index,
        error: errorMessage,
      });

      recordLlmCall({
        taskType: input.taskType,
        model: route.model,
        provider: route.provider,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        success: false,
        metadata: { error: errorMessage, routeIndex: index },
      });
    }
  }

  throw new Error(`All LLM routes failed for ${input.taskType}: ${errors.join(" | ")}`);
}
