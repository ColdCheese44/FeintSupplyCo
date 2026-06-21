import "dotenv/config";

import { performance } from "node:perf_hooks";

import { runClaudeCompletion } from "./claude-client.js";
import { recordLlmCall } from "./db.js";
import { generateIdeogramImages } from "./ideogram-client.js";
import { createLogger } from "./logger.js";
import { generateOpenAIImageToPath, generateOpenAIText } from "./openai-client.js";
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

type ProviderName = "claude" | "openai" | "openai_image" | "ideogram" | "recraft" | "replicate";

interface RouteDefinition {
  provider: ProviderName;
  model: string;
}

export interface CallLlmInput {
  taskType: LlmTaskType;
  prompt: string;
  system?: string;
  destinationPath?: string;
  destinationPaths?: string[];
  temperature?: number;
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
 * Builds the ordered provider route list from the project routing policy for the given task type.
 */
function getRouteDefinitions(taskType: LlmTaskType): RouteDefinition[] {
  const strategy = getRoutingStrategy();
  const openAiTextModel = strategy === "speed_first" ? "gpt-4.1-mini" : "gpt-4.1";
  const claudePrimaryModel = "claude-sonnet-4-6";
  const claudeLightweightModel = "claude-haiku-4-5-20251001";
  const fluxSchnellModel = "black-forest-labs/flux-schnell";
  const sdxlModel = "stability-ai/sdxl";
  const mockupModel = "gpt-image-1";

  switch (taskType) {
    case "listing_copywriting":
    case "product_description_seo":
    case "trend_analysis_reasoning":
    case "trademark_dossier_writing":
      return [
        { provider: "claude", model: claudePrimaryModel },
        { provider: "openai", model: openAiTextModel },
      ];
    case "customer_service_replies":
      return [
        { provider: "claude", model: claudeLightweightModel },
        { provider: "openai", model: "gpt-4.1-mini" },
      ];
    case "photorealistic_mockups":
      return [
        { provider: "openai_image", model: mockupModel },
        { provider: "replicate", model: fluxSchnellModel },
        { provider: "replicate", model: sdxlModel },
      ];
    case "apparel_design_with_text":
      return [
        { provider: "ideogram", model: "ideogram-v3" },
        { provider: "openai_image", model: mockupModel },
        { provider: "replicate", model: fluxSchnellModel },
      ];
    case "vector_logos":
      return [
        { provider: "recraft", model: "recraftv4" },
        { provider: "ideogram", model: "ideogram-v3" },
        { provider: "replicate", model: fluxSchnellModel },
      ];
    case "shop_banner":
      return [
        { provider: "openai_image", model: mockupModel },
        { provider: "replicate", model: fluxSchnellModel },
        { provider: "ideogram", model: "ideogram-v3" },
      ];
    case "bulk_variant_generation":
      return [
        { provider: "replicate", model: fluxSchnellModel },
        { provider: "openai_image", model: mockupModel },
      ];
  }
}

/**
 * Estimates text-model cost conservatively enough to support routing analytics and spend caps.
 */
function estimateTextCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-6": { input: 0.000003, output: 0.000015 },
    "claude-haiku-4-5-20251001": { input: 0.000001, output: 0.000005 },
    "gpt-4.1": { input: 0.000002, output: 0.000008 },
    "gpt-4.1-mini": { input: 0.0000004, output: 0.0000016 },
  };

  const rate = rates[model] ?? { input: 0.000002, output: 0.000008 };
  return Number(((promptTokens * rate.input) + (completionTokens * rate.output)).toFixed(6));
}

/**
 * Estimates image-model cost conservatively enough to support design budget enforcement.
 */
function estimateImageCost(model: string): number {
  const rates: Record<string, number> = {
    "gpt-image-1": 0.06,
    "ideogram-v3": 0.08,
    "recraftv4": 0.06,
    "black-forest-labs/flux-schnell": 0.01,
    "stability-ai/sdxl": 0.01,
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
        temperature: input.temperature,
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
    case "openai": {
      const response = await generateOpenAIText(input.prompt, {
        model: route.model,
        system: input.system,
        maxOutputTokens: input.maxTokens,
        temperature: input.temperature,
      });

      return {
        provider: route.provider,
        model: response.model,
        text: input.expectJson ? response.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim() : response.text,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        costUsd: estimateTextCost(response.model, response.promptTokens, response.completionTokens),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
    case "openai_image": {
      if (!input.destinationPath) {
        throw new Error(`Task ${input.taskType} requires destinationPath for image output.`);
      }

      const response = await generateOpenAIImageToPath(input.prompt, {
        model: route.model,
        destinationPath: input.destinationPath,
        size: input.size,
      });

      return {
        provider: route.provider,
        model: response.model,
        destinationPaths: [response.destinationPath],
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        costUsd: estimateImageCost(response.model),
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
  const routes = getRouteDefinitions(input.taskType);
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
