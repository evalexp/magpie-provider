/**
 * Magpie Provider Extension for Pi-Coding-Agent
 *
 * Provides integration with Magpie LLM gateway (https://github.com/yetone/magpie).
 * Allows configuring the gateway URL and API key via `/login` or `/magpie-login`,
 * automatically discovers all available models and their capabilities/parameters,
 * and configures them for use within Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface MagpieModelItem {
  id: string;
  display_name?: string;
  name?: string;
  magpie_label?: string;
  owned_by?: string;
  context_window?: number;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  reasoning_levels?: string[];
  supported_reasoning_levels?: Array<{ effort: string }>;
  native_endpoints?: string[];
  input?: string[];
  tool_call?: boolean;
  supported_parameters?: string[];
  modalities?: {
    input?: string[];
    output?: string[];
  };
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    input?: number;
    output?: number;
    cache_read?: string | number;
    cache_write?: string | number;
  };
}

export interface PiModelDefinition {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  promptCache?: {
    short?: number;
    long?: number;
  };
  compat?: Record<string, any>;
}

export interface SavedMagpieConfig {
  baseUrl: string;
  apiKey: string;
}

// =============================================================================
// Helper Functions for Path & Config Management
// =============================================================================

function getAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return process.env.PI_CODING_AGENT_DIR;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return path.join(getAgentDir(), "auth.json");
}

function normalizeGatewayUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  url = url.replace(/\/+$/, "");
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3);
  }
  return url.replace(/\/+$/, "");
}

const BACKGROUND_REFRESH_TIMEOUT_MS = 30_000;
const LOGIN_FETCH_TIMEOUT_MS = 30_000;

/** Endpoint names that never describe a chat model. */
const NON_CHAT_ENDPOINT_RE = /embedding|rerank|image|audio|moderation|transcription/i;
const CHAT_ENDPOINT_RE = /chat|messages|responses|completions|gemini|v1beta/i;

export class MagpieHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MagpieHttpError";
    this.status = status;
  }
}

function isChatModel(m: MagpieModelItem): boolean {
  const endpoints = m.native_endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return true;
  if (endpoints.some((endpoint) => CHAT_ENDPOINT_RE.test(endpoint))) return true;
  // Keep unknown endpoint names; only drop models that are clearly non-chat.
  return !endpoints.every((endpoint) => NON_CHAT_ENDPOINT_RE.test(endpoint));
}

/**
 * Normalizes a gateway price to Pi's unit (USD per million tokens).
 * Magpie/OpenRouter catalogs publish per-token prices, which are orders of
 * magnitude below any per-million price; larger values are already per-million.
 */
function parsePrice(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 0.001 ? parsed * 1_000_000 : parsed;
}

/**
 * Claude 4.6+ and 5+ require adaptive thinking (`thinking.type: "adaptive"`).
 * Handles both `claude-4-6-sonnet` and `claude-sonnet-4-6` id styles, and avoids
 * matching date suffixes such as `claude-sonnet-4-20250514`.
 */
function needsAdaptiveThinking(id: string): boolean {
  if (!/claude/i.test(id)) return false;
  const pair = id.match(/(\d{1,2})[.-](\d{1,2})(?!\d)/);
  if (pair) {
    const major = Number(pair[1]);
    const minor = Number(pair[2]);
    return major > 4 || (major === 4 && minor >= 6);
  }
  const major = id.match(/claude[^0-9]*(\d+)/i);
  return major ? Number(major[1]) >= 5 : false;
}

function inferContextWindow(id: string, given?: number): number {
  if (given && Number.isFinite(given) && given > 0) return given;
  const lower = id.toLowerCase();
  if (/(^|[^a-z0-9])1m([^a-z0-9]|$)/i.test(id)) return 1000000;
  if (
    lower.includes("opus-4-6") ||
    lower.includes("opus-4-7") ||
    lower.includes("opus-4-8") ||
    lower.includes("opus-5") ||
    lower.includes("sonnet-4-6") ||
    lower.includes("sonnet-5") ||
    lower.includes("claude-fable")
  ) {
    return 1000000;
  }
  if (lower.includes("gpt-4.1") || lower.includes("gpt-4-1")) return 1000000;
  if (lower.includes("gpt-5")) return 400000;
  if (lower.includes("claude-") || lower.includes("gpt-4")) {
    return lower.includes("claude-") ? 200000 : 128000;
  }
  return 128000;
}

function inferMaxTokens(id: string, given?: number): number {
  if (given && Number.isFinite(given) && given > 0) return given;
  const lower = id.toLowerCase();
  if (
    lower.includes("sonnet-4-6") ||
    lower.includes("opus-4-6") ||
    lower.includes("sonnet-5") ||
    lower.includes("opus-5") ||
    lower.includes("claude-fable")
  ) {
    return 128000;
  }
  if (lower.includes("sonnet-4-5") || lower.includes("opus-4-5") || lower.includes("haiku-4-5")) {
    return 64000;
  }
  return 16384;
}

export function loadSavedConfig(): SavedMagpieConfig | null {
  let baseUrl = (process.env.MAGPIE_BASE_URL || "").trim();
  let apiKey = (process.env.MAGPIE_API_KEY || "").trim();

  // Read auth.json
  try {
    const authPath = getAuthPath();
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const magpieAuth = auth.magpie;
      if (magpieAuth) {
        if (!apiKey) {
          // Accept both the api_key shape this extension stores and the standard
          // OAuth shape (`access`) so credentials keep working if Pi normalizes them.
          const stored = typeof magpieAuth.key === "string" ? magpieAuth.key : magpieAuth.access;
          if (typeof stored === "string" && stored.length > 0) {
            apiKey = stored;
          }
        }
        if (!baseUrl && typeof magpieAuth.env?.MAGPIE_BASE_URL === "string") {
          baseUrl = magpieAuth.env.MAGPIE_BASE_URL;
        }
      }
    }
  } catch {}

  baseUrl = normalizeGatewayUrl(baseUrl);

  // Without a credential this is not a usable configuration: do not register a
  // provider that points at a gateway, otherwise Pi would treat it as logged in and
  // refresh it. `MAGPIE_BASE_URL` alone is only used by the /login prompt.
  if (!apiKey) {
    return null;
  }

  return {
    baseUrl,
    apiKey,
  };
}

// =============================================================================
// Model Conversion & Discovery
// =============================================================================

export function convertMagpieModel(m: MagpieModelItem, gatewayUrl: string): PiModelDefinition {
  const base = normalizeGatewayUrl(gatewayUrl);
  const id = m.id;
  const name = m.display_name || m.name || m.magpie_label || id;
  const nativeEndpoints = m.native_endpoints || [];

  let api = "openai-completions";
  let modelBaseUrl = `${base}/v1`;
  const compat: Record<string, any> = {};

  if (nativeEndpoints.includes("/v1/messages")) {
    api = "anthropic-messages";
    modelBaseUrl = base; // Pi's anthropic-messages appends /v1/messages
    // Claude 4.6+ and 5+ only support adaptive thinking.
    if (needsAdaptiveThinking(id)) {
      compat.forceAdaptiveThinking = true;
    }
  } else if (nativeEndpoints.includes("/v1/responses")) {
    api = "openai-responses";
    modelBaseUrl = `${base}/v1`;
  } else if (nativeEndpoints.some((e) => e.includes("gemini") || e.includes("v1beta"))) {
    api = "google-generative-ai";
    modelBaseUrl = `${base}/v1beta`;
  }

  const reasoning = Boolean(
    m.reasoning ||
      (m.reasoning_levels && m.reasoning_levels.length > 0) ||
      (m.supported_reasoning_levels && m.supported_reasoning_levels.length > 0),
  );

  let thinkingLevelMap: Record<string, string | null> | undefined;
  if (reasoning) {
    const efforts: string[] =
      m.reasoning_levels || m.supported_reasoning_levels?.map((s) => s.effort) || [];
    if (efforts.length > 0) {
      thinkingLevelMap = {
        minimal: efforts.includes("minimal") ? "minimal" : (efforts.includes("low") ? "low" : null),
        low: efforts.includes("low") ? "low" : null,
        medium: efforts.includes("medium") ? "medium" : null,
        high: efforts.includes("high") ? "high" : null,
        xhigh: efforts.includes("xhigh") ? "xhigh" : (efforts.includes("max") ? "max" : (efforts.includes("high") ? "high" : null)),
        max: efforts.includes("max") ? "max" : (efforts.includes("high") ? "high" : null),
      };
      // Anthropic disables thinking by omitting the parameter, so only map "off" to an
      // explicit provider value when the gateway advertises one. Mapping it to null
      // would hide the "off" level from /thinking for every Claude model.
      if (efforts.includes("none")) {
        thinkingLevelMap.off = "none";
      } else if (api !== "anthropic-messages") {
        thinkingLevelMap.off = null;
      }
    }
  }

  const contextWindow = inferContextWindow(id, m.context_window || m.context_length || m.max_input_tokens);
  const maxTokens = inferMaxTokens(id, m.max_output_tokens);
  // Missing modality metadata means "unknown"; assume text-only so Pi never sends
  // images to a model that would reject them upstream.
  const modalityInput = m.modalities?.input ?? m.input;
  const hasImage = Array.isArray(modalityInput) ? modalityInput.includes("image") : false;
  const input: ("text" | "image")[] = hasImage ? ["text", "image"] : ["text"];

  const cost = {
    input: parsePrice(m.pricing?.prompt ?? m.pricing?.input),
    output: parsePrice(m.pricing?.completion ?? m.pricing?.output),
    cacheRead: parsePrice(m.pricing?.cache_read),
    cacheWrite: parsePrice(m.pricing?.cache_write),
  };

  const modelDef: PiModelDefinition = {
    id,
    name,
    api,
    baseUrl: modelBaseUrl,
    reasoning,
    input,
    contextWindow,
    maxTokens,
    cost,
  };

  if (thinkingLevelMap) {
    modelDef.thinkingLevelMap = thinkingLevelMap;
  }
  if (Object.keys(compat).length > 0) {
    modelDef.compat = compat;
  }
  if (api === "anthropic-messages" && id.toLowerCase().includes("claude")) {
    modelDef.promptCache = { short: 300, long: 3600 };
  } else if (api === "openai-responses" && id.toLowerCase().includes("gpt")) {
    modelDef.promptCache = { short: 300 };
  }

  return modelDef;
}

export async function fetchMagpieModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PiModelDefinition[]> {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) {
    throw new Error("Magpie Gateway URL cannot be empty.");
  }
  const url = `${base}/v1/models`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    Accept: "application/json",
  };

  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    // Read the body once: res.json() followed by res.text() cannot work because the
    // first read consumes the stream.
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    let errDetail = `${res.status} ${res.statusText}`;
    if (bodyText) {
      try {
        const errJson = JSON.parse(bodyText) as any;
        errDetail = errJson?.error?.message || errJson?.message || bodyText.slice(0, 500);
      } catch {
        errDetail = bodyText.slice(0, 500);
      }
    }
    throw new MagpieHttpError(`Failed to query Magpie models (${errDetail})`, res.status);
  }

  const json = (await res.json()) as any;
  const rawList: MagpieModelItem[] = Array.isArray(json) ? json : json.data || [];
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error("No models returned by Magpie gateway.");
  }

  const seen = new Set<string>();
  const chatModels = rawList.filter((item) => {
    if (!item || typeof item.id !== "string" || item.id.length === 0) return false;
    if (seen.has(item.id)) return false;
    if (!isChatModel(item)) return false;
    seen.add(item.id);
    return true;
  });

  return chatModels.map((item) => convertMagpieModel(item, base));
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function magpieProviderExtension(pi: ExtensionAPI) {
  let saved = loadSavedConfig();
  // Seeded from Pi's persisted model store inside refreshModels, never from the
  // network during startup.
  let currentModels: PiModelDefinition[] = [];
  let refreshInFlight: Promise<PiModelDefinition[]> | null = null;
  // Captured from refreshModels so a later background refresh can persist through
  // Pi's model store (models-store.json) instead of a private cache file.
  let publishModels: ((models: PiModelDefinition[]) => Promise<unknown>) | null = null;

  const fetchModels = async (signal?: AbortSignal): Promise<PiModelDefinition[]> => {
    const cfg = loadSavedConfig();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl) {
      currentModels = [];
      return [];
    }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const models = await fetchMagpieModels(cfg.baseUrl, cfg.apiKey, signal);
        currentModels = models;
        return models;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  const registerMagpie = (baseUrl: string, apiKey: string, models: PiModelDefinition[]) => {
    pi.registerProvider("magpie", {
      name: "Magpie",
      baseUrl: baseUrl ? `${baseUrl}/v1` : "",
      apiKey: apiKey || "$MAGPIE_API_KEY",
      api: "openai-completions",
      compat: {
        sendSessionAffinityHeaders: true,
      },
      models: models,
      refreshModels: async (context: {
        signal?: AbortSignal;
        allowNetwork?: boolean;
        stored?: { models?: PiModelDefinition[] } | null;
        publish?: (entry: {
          persist: { models: PiModelDefinition[]; checkedAt: number };
        }) => Promise<unknown>;
      }) => {
        const cfg = loadSavedConfig();
        if (!cfg || !cfg.apiKey || !cfg.baseUrl) {
          currentModels = [];
          return [];
        }

        if (typeof context?.publish === "function") {
          const publish = context.publish;
          publishModels = (models) => publish({ persist: { models, checkedAt: Date.now() } });
        }

        // Seed from the catalog Pi already persisted (models-store.json) so startup
        // and --list-models never need the gateway.
        const stored = Array.isArray(context?.stored?.models) ? context.stored.models : [];
        if (currentModels.length === 0 && stored.length > 0) {
          currentModels = stored;
        }

        // Pi sets allowNetwork=false for startup and list commands.
        if (context?.allowNetwork === false) {
          if (currentModels.length > 0) {
            return currentModels;
          }
          // First run without a persisted catalog: fetch once so models are usable.
          try {
            const models = await fetchModels(context?.signal);
            if (models.length > 0) {
              await context?.publish?.({ persist: { models, checkedAt: Date.now() } });
            }
            return models;
          } catch {
            return currentModels;
          }
        }

        try {
          const models = await fetchModels(context?.signal);
          if (models.length > 0) {
            await context?.publish?.({ persist: { models, checkedAt: Date.now() } });
          }
          return models;
        } catch {
          return currentModels;
        }
      },
      oauth: {
        name: "Magpie Gateway",
        login: async (callbacks) => {
          let url = process.env.MAGPIE_BASE_URL || saved?.baseUrl || "";
          url = normalizeGatewayUrl(url);

          // If URL is not set via env or saved config, prompt for it
          if (!url) {
            const rawUrl = await callbacks.onPrompt({
              message: "Magpie Gateway URL (or set MAGPIE_BASE_URL env var):",
            });
            url = normalizeGatewayUrl(rawUrl?.trim() || "");
            if (!url) {
              throw new Error("Magpie Gateway URL cannot be empty. Please set MAGPIE_BASE_URL or enter a URL.");
            }
          }

          const apiKey = (
            await callbacks.onPrompt({
              message: `Magpie API Key (${url}):`,
            })
          )?.trim();

          if (!apiKey) {
            throw new Error("Magpie API key cannot be empty.");
          }

          let models = currentModels;
          try {
            models = await fetchMagpieModels(url, apiKey, AbortSignal.timeout(LOGIN_FETCH_TIMEOUT_MS));
          } catch (error) {
            // A rejected key is a real login failure; an unreachable gateway is not.
            // Keep the cached catalog so refreshModels can retry once it is reachable.
            if (error instanceof MagpieHttpError && (error.status === 401 || error.status === 403)) {
              throw error;
            }
          }

          saved = { baseUrl: url, apiKey };
          currentModels = models;
          registerMagpie(url, apiKey, models);

          return {
            type: "api_key",
            key: apiKey,
            env: {
              MAGPIE_BASE_URL: url,
            },
          } as any;
        },
        getApiKey: (cred: any) => cred?.key || cred?.access,
      },
    });
  };

  // Initial registration; Pi calls refreshModels during startup, which seeds the
  // catalog from Pi's model store without blocking on the network.
  registerMagpie(saved?.baseUrl || "", saved?.apiKey || "", currentModels);

  // Refresh asynchronously after startup, like Pi's built-in providers: startup and
  // list commands keep using the cached catalog, and a failed refresh just leaves it
  // in place.
  pi.on("session_start", () => {
    const cfg = loadSavedConfig();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl) return;
    void (async () => {
      try {
        const models = await fetchModels(AbortSignal.timeout(BACKGROUND_REFRESH_TIMEOUT_MS));
        if (models.length === 0) return;
        registerMagpie(cfg.baseUrl, cfg.apiKey, models);
        if (publishModels) {
          await publishModels(models);
        }
      } catch {
        // Keep the cached catalog when the gateway is unreachable.
      }
    })();
  });
}
