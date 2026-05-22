import type { LogLevel } from './observability/logger.js';
import {
  loadConfig,
  readConfigFromEnv,
  resetConfigCache,
  resolveProviderApiKey,
} from './config.js';

/** Supported provider names for environment-based configuration. */
export type AgenticProviderName = 'anthropic' | 'openai' | 'ollama';

/** Resolved environment configuration for agent-kit (legacy shape). */
export interface AgenticEnv {
  /** Default provider from `AGENTIC_PROVIDER` / `AGENTIC_DEFAULT_PROVIDER`. */
  provider?: AgenticProviderName;
  /** Default model from `AGENTIC_MODEL` / `AGENTIC_DEFAULT_MODEL`. */
  model?: string;
  /** Anthropic API key from `ANTHROPIC_API_KEY` or config. */
  anthropicApiKey?: string;
  /** OpenAI API key from `OPENAI_API_KEY` or config. */
  openaiApiKey?: string;
  /** Ollama base URL from `OLLAMA_BASE_URL` or config. */
  ollamaBaseUrl?: string;
  /** Log level from `AGENTIC_LOG_LEVEL`. */
  logLevel?: LogLevel;
  /** Default max ReAct steps from `AGENTIC_MAX_STEPS`. */
  maxSteps?: number;
}

function isKnownProvider(value: string): value is AgenticProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'ollama';
}

function toAgenticEnv(config: ReturnType<typeof loadConfig>['config']): AgenticEnv {
  const provider = config.defaultProvider.toLowerCase();

  return {
    provider: isKnownProvider(provider) ? provider : undefined,
    model: config.defaultModel,
    anthropicApiKey: resolveProviderApiKey(config, 'anthropic'),
    openaiApiKey: resolveProviderApiKey(config, 'openai'),
    ollamaBaseUrl: config.providers.ollama?.baseUrl,
    logLevel: config.logLevel === 'silent' ? undefined : config.logLevel,
    maxSteps: config.maxSteps,
  };
}

/** Map fully merged configuration to the legacy {@link AgenticEnv} shape. */
export function configToAgenticEnv(env: NodeJS.ProcessEnv = process.env): AgenticEnv {
  return toAgenticEnv(loadConfig({ env }).config);
}

/**
 * Read **environment variables only** (no config file) into the legacy {@link AgenticEnv} shape.
 *
 * Prefer {@link loadConfig} for the full merged configuration.
 */
export function readAgenticEnv(env: NodeJS.ProcessEnv = process.env): AgenticEnv {
  const partial = readConfigFromEnv(env);
  const providerRaw = partial.defaultProvider?.toLowerCase();

  return {
    provider: providerRaw && isKnownProvider(providerRaw) ? providerRaw : undefined,
    model: partial.defaultModel,
    anthropicApiKey:
      partial.providers?.anthropic?.apiKey ??
      (env.ANTHROPIC_API_KEY?.trim() || undefined),
    openaiApiKey:
      partial.providers?.openai?.apiKey ?? (env.OPENAI_API_KEY?.trim() || undefined),
    ollamaBaseUrl:
      partial.providers?.ollama?.baseUrl ?? (env.OLLAMA_BASE_URL?.trim() || undefined),
    logLevel:
      partial.logLevel && partial.logLevel !== 'silent' ? partial.logLevel : undefined,
    maxSteps: partial.maxSteps,
  };
}

let cachedEnv: AgenticEnv | undefined;

/**
 * Cached snapshot of merged configuration (includes `.agenticrc.*` when present).
 *
 * For env-only reads, use {@link readAgenticEnv}.
 */
export function getAgenticEnv(): AgenticEnv {
  if (!cachedEnv) {
    cachedEnv = configToAgenticEnv();
  }
  return cachedEnv;
}

/** Clear cached environment and factory defaults (for tests). */
export function resetAgenticEnvCache(): void {
  cachedEnv = undefined;
  resetConfigCache();
}

/** Resolve an API key for a provider using override, merged config, and environment. */
export function resolveApiKey(
  provider: AgenticProviderName,
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (override) {
    return override;
  }
  const { config } = loadConfig({ env, configPath: false });
  return resolveProviderApiKey(config, provider);
}
