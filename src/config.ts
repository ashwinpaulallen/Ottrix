import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
} from './providers/index.js';
import { parseYamlSubset } from './orchestration/yaml-parse.js';
import type { LogLevel } from './observability/logger.js';

/** Log level for agentic-fabric (includes `silent` to disable logging). */
export type AgenticLogLevel = LogLevel | 'silent';

/** Telemetry exporter identifier. */
export type AgenticTelemetryExporter = 'console' | 'memory' | 'none' | (string & {});

/** Provider connection settings in config files and {@link AgenticConfig}. */
export interface AgenticProviderConfig {
  /** API key or bearer token. */
  apiKey?: string;
  /** API base URL (OpenAI-compatible or Ollama). */
  baseUrl?: string;
  /** Default model for this provider. */
  model?: string;
}

/**
 * Alias for {@link AgenticProviderConfig}.
 *
 * @deprecated Prefer `AgenticProviderConfig` — `ProviderConfig` in `agentic-fabric/types` is the LLM connection type.
 */
export type ProviderConfig = AgenticProviderConfig;

/** Telemetry section of {@link AgenticConfig}. */
export interface AgenticTelemetryConfig {
  enabled: boolean;
  exporter: AgenticTelemetryExporter;
}

/** Guardrails section of {@link AgenticConfig}. */
export interface AgenticGuardrailsConfig {
  piiDetection: boolean;
  maxCostUsd?: number;
}

/**
 * Fully resolved agentic-fabric configuration.
 */
export interface AgenticConfig {
  defaultProvider: string;
  providers: Record<string, AgenticProviderConfig>;
  defaultModel: string;
  maxSteps: number;
  maxTokenBudget?: number;
  logLevel: AgenticLogLevel;
  telemetry: AgenticTelemetryConfig;
  guardrails: AgenticGuardrailsConfig;
}

/** Partial config accepted by {@link loadConfig} overrides and config files. */
export type AgenticConfigInput = Partial<
  Omit<AgenticConfig, 'providers' | 'telemetry' | 'guardrails'>
> & {
  providers?: Record<string, AgenticProviderConfig>;
  telemetry?: Partial<AgenticTelemetryConfig>;
  guardrails?: Partial<AgenticGuardrailsConfig>;
  /** @deprecated Use `defaultProvider` */
  provider?: string;
  /** @deprecated Use `defaultModel` */
  model?: string;
  /** @deprecated Use `telemetry.enabled` */
  telemetryEnabled?: boolean;
};

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Project root used to discover `.agenticrc.*` files. @defaultValue `process.cwd()` */
  cwd?: string;
  /** Environment source. @defaultValue `process.env` */
  env?: NodeJS.ProcessEnv;
  /** Explicit config file path, or `false` to skip file discovery. */
  configPath?: string | false;
  /** Highest-priority overrides (constructor / programmatic params). */
  overrides?: AgenticConfigInput;
}

/** Result of {@link loadConfig}. */
export interface LoadConfigResult {
  config: AgenticConfig;
  warnings: ConfigWarning[];
  /** Absolute path to the loaded config file, if any. */
  configFilePath?: string;
}

/** Non-fatal configuration warning. */
export interface ConfigWarning {
  code: 'deprecated_option' | 'unknown_provider' | 'unknown_exporter' | 'invalid_env_value';
  message: string;
  path?: string;
}

/** Validation issue (fatal). */
export interface ConfigIssue {
  code: 'invalid_value' | 'missing_required';
  message: string;
  path?: string;
}

/** Thrown when configuration validation fails. */
export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(message: string, issues: ConfigIssue[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const KNOWN_PROVIDERS = new Set<string>(['anthropic', 'openai', 'ollama']);

/** Built-in provider names supported by {@link createAgent} string shorthand. */
export type BuiltInProviderName = 'anthropic' | 'openai' | 'ollama';

/** Returns true when `name` is a built-in provider (`anthropic`, `openai`, `ollama`). */
export function isBuiltInProviderName(name: string): name is BuiltInProviderName {
  return KNOWN_PROVIDERS.has(name.toLowerCase());
}
const LOG_LEVELS = new Set<AgenticLogLevel>(['debug', 'info', 'warn', 'error', 'silent']);
const TELEMETRY_EXPORTERS = new Set<string>(['console', 'memory', 'none']);

const DEPRECATED_ROOT_KEYS: Record<string, keyof AgenticConfigInput> = {
  provider: 'defaultProvider',
  model: 'defaultModel',
  telemetryEnabled: 'telemetry',
};

const CONFIG_FILE_NAMES = ['.agenticrc.json', '.agenticrc.yaml', '.agenticrc.yml'] as const;

/** Built-in defaults (lowest priority). */
export const DEFAULT_AGENTIC_CONFIG: AgenticConfig = {
  defaultProvider: 'anthropic',
  providers: {},
  defaultModel: ANTHROPIC_DEFAULT_MODEL,
  maxSteps: 10,
  logLevel: 'info',
  telemetry: {
    enabled: true,
    exporter: 'memory',
  },
  guardrails: {
    piiDetection: true,
  },
};

let cachedConfig: LoadConfigResult | undefined;
let createAgentDefaultsApplied = false;

/** Whether {@link import('./factory.js').createAgent} has applied global logger defaults. */
export function wereCreateAgentDefaultsApplied(): boolean {
  return createAgentDefaultsApplied;
}

/** @internal */
export function markCreateAgentDefaultsApplied(): void {
  createAgentDefaultsApplied = true;
}

/** Reset logger defaults flag without clearing cached {@link loadConfig} (for tests). */
export function resetCreateAgentDefaultsState(): void {
  createAgentDefaultsApplied = false;
}

/**
 * Type-safe helper for `.agenticrc` and `agentic.config` modules (Vite-style).
 *
 * @example
 * ```ts
 * // agentic.config.ts
 * import { defineConfig } from 'agentic-fabric';
 * export default defineConfig({ defaultProvider: 'openai' });
 * ```
 */
export function defineConfig<T extends AgenticConfigInput>(config: T): T {
  return config;
}

/**
 * Discover and merge configuration from defaults, config file, environment, and overrides.
 *
 * Priority (highest first): `overrides` → environment (`AGENTIC_*`) → config file → defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const warnings: ConfigWarning[] = [];

  const filePath =
    options.configPath === false
      ? undefined
      : (options.configPath ?? discoverConfigFile(cwd, env));

  const fileInput = filePath ? readConfigFile(filePath, warnings) : {};
  const envInput = readConfigFromEnv(env);
  collectEnvWarnings(env, warnings);
  const overrideInput = normalizeInput(options.overrides ?? {}, warnings);

  const merged = mergeAgenticConfig(
    DEFAULT_AGENTIC_CONFIG,
    normalizeInput(fileInput, warnings),
    envInput,
    overrideInput,
  );

  const issues = validateAgenticConfig(merged, warnings);
  if (issues.length > 0) {
    throw new ConfigValidationError(
      `Invalid agentic-fabric configuration: ${issues.map((i) => i.message).join('; ')}`,
      issues,
    );
  }

  applyProviderApiKeysFromEnv(merged, env);

  const result: LoadConfigResult = {
    config: merged,
    warnings,
    configFilePath: filePath,
  };

  return result;
}

/** Cached {@link loadConfig} result (cleared by {@link resetConfigCache}). */
export function getConfig(): AgenticConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig.config;
}

/** Replace the cached configuration (for tests or explicit initialization). */
export function setConfig(config: AgenticConfig, warnings: ConfigWarning[] = []): void {
  cachedConfig = { config, warnings };
}

/** Clear cached configuration and factory runtime defaults. */
export function resetConfigCache(): void {
  cachedConfig = undefined;
  createAgentDefaultsApplied = false;
}

/**
 * Discover config file: `AGENTIC_CONFIG_PATH`, then `.agenticrc.json`, then `.agenticrc.yaml`.
 */
export function discoverConfigFile(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = readEnv(env, 'AGENTIC_CONFIG_PATH');
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  for (const name of CONFIG_FILE_NAMES) {
    const path = join(cwd, name);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

function readConfigFile(filePath: string, warnings: ConfigWarning[]): AgenticConfigInput {
  const content = readFileSync(filePath, 'utf8');
  const lower = filePath.toLowerCase();
  let raw: unknown;

  if (lower.endsWith('.json')) {
    raw = JSON.parse(content) as unknown;
  } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    raw = parseYamlSubset(content);
  } else {
    throw new Error(`Unsupported config file format: ${filePath}`);
  }

  if (!isPlainObject(raw)) {
    throw new Error(`Config file must contain an object: ${filePath}`);
  }

  return normalizeInput(raw, warnings);
}

/** Parse `AGENTIC_*` and related provider env vars into a partial config. */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgenticConfigInput {
  const partial: AgenticConfigInput = {};

  const defaultProvider = readEnv(env, 'AGENTIC_DEFAULT_PROVIDER') ?? readEnv(env, 'AGENTIC_PROVIDER');
  if (defaultProvider) {
    partial.defaultProvider = defaultProvider;
  }

  const defaultModel = readEnv(env, 'AGENTIC_DEFAULT_MODEL') ?? readEnv(env, 'AGENTIC_MODEL');
  if (defaultModel) {
    partial.defaultModel = defaultModel;
  }

  const maxSteps = parsePositiveInt(readEnv(env, 'AGENTIC_MAX_STEPS'));
  if (maxSteps !== undefined) {
    partial.maxSteps = maxSteps;
  }

  const maxTokenBudget = parsePositiveInt(readEnv(env, 'AGENTIC_MAX_TOKEN_BUDGET'));
  if (maxTokenBudget !== undefined) {
    partial.maxTokenBudget = maxTokenBudget;
  }

  const logLevel = parseLogLevel(readEnv(env, 'AGENTIC_LOG_LEVEL'));
  if (logLevel) {
    partial.logLevel = logLevel;
  }

  const telemetryEnabled = parseBoolean(readEnv(env, 'AGENTIC_TELEMETRY_ENABLED'));
  const telemetryExporter = readEnv(env, 'AGENTIC_TELEMETRY_EXPORTER');
  if (telemetryEnabled !== undefined || telemetryExporter) {
    partial.telemetry = {
      ...(telemetryEnabled !== undefined ? { enabled: telemetryEnabled } : {}),
      ...(telemetryExporter ? { exporter: telemetryExporter } : {}),
    };
  }

  const piiDetection = parseBoolean(readEnv(env, 'AGENTIC_GUARDRAILS_PII_DETECTION'));
  const maxCostUsd = parsePositiveFloat(readEnv(env, 'AGENTIC_GUARDRAILS_MAX_COST_USD'));
  if (piiDetection !== undefined || maxCostUsd !== undefined) {
    partial.guardrails = {
      ...(piiDetection !== undefined ? { piiDetection } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    };
  }

  const providers: Record<string, AgenticProviderConfig> = {};

  if (readEnv(env, 'ANTHROPIC_API_KEY')) {
    providers.anthropic = { apiKey: readEnv(env, 'ANTHROPIC_API_KEY') };
  }
  if (readEnv(env, 'OPENAI_API_KEY')) {
    providers.openai = { apiKey: readEnv(env, 'OPENAI_API_KEY') };
  }
  const ollamaBaseUrl = readEnv(env, 'OLLAMA_BASE_URL');
  if (ollamaBaseUrl) {
    providers.ollama = { baseUrl: ollamaBaseUrl };
  }

  for (const provider of ['anthropic', 'openai', 'ollama'] as const) {
    const upper = provider.toUpperCase();
    const apiKey = readEnv(env, `AGENTIC_${upper}_API_KEY`);
    const baseUrl = readEnv(env, `AGENTIC_${upper}_BASE_URL`);
    const model = readEnv(env, `AGENTIC_${upper}_MODEL`);
    if (apiKey || baseUrl || model) {
      providers[provider] = {
        ...providers[provider],
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
      };
    }
  }

  if (Object.keys(providers).length > 0) {
    partial.providers = providers;
  }

  return partial;
}

function normalizeInput(input: AgenticConfigInput, warnings: ConfigWarning[]): AgenticConfigInput {
  const normalized: AgenticConfigInput = { ...input };

  for (const [deprecated, replacement] of Object.entries(DEPRECATED_ROOT_KEYS)) {
    if (deprecated in input && input[deprecated as keyof AgenticConfigInput] !== undefined) {
      warnings.push({
        code: 'deprecated_option',
        message: `Config option "${deprecated}" is deprecated; use "${String(replacement)}" instead`,
        path: deprecated,
      });

      const legacyValue = input[deprecated as keyof AgenticConfigInput];
      if (deprecated === 'provider' && !normalized.defaultProvider && typeof legacyValue === 'string') {
        normalized.defaultProvider = legacyValue;
      }
      if (deprecated === 'model' && !normalized.defaultModel && typeof legacyValue === 'string') {
        normalized.defaultModel = legacyValue;
      }
      if (deprecated === 'telemetryEnabled' && !normalized.telemetry) {
        normalized.telemetry = {
          enabled: Boolean(input.telemetryEnabled),
        };
      }
    }
  }

  if (isPlainObject(input.telemetry) && 'telemetryEnabled' in input.telemetry) {
    warnings.push({
      code: 'deprecated_option',
      message: 'telemetry.telemetryEnabled is deprecated; use telemetry.enabled',
      path: 'telemetry.telemetryEnabled',
    });
  }

  return normalized;
}

export function mergeAgenticConfig(
  base: AgenticConfig,
  ...sources: AgenticConfigInput[]
): AgenticConfig {
  const result: AgenticConfig = structuredClone(base);

  for (const source of sources) {
    if (!source) {
      continue;
    }

    if (source.defaultProvider !== undefined) {
      result.defaultProvider = source.defaultProvider;
    }
    if (source.defaultModel !== undefined) {
      result.defaultModel = source.defaultModel;
    }
    if (source.maxSteps !== undefined) {
      result.maxSteps = source.maxSteps;
    }
    if (source.maxTokenBudget !== undefined) {
      result.maxTokenBudget = source.maxTokenBudget;
    }
    if (source.logLevel !== undefined) {
      result.logLevel = source.logLevel;
    }

    if (source.telemetry) {
      result.telemetry = { ...result.telemetry, ...source.telemetry };
    }

    if (source.guardrails) {
      result.guardrails = { ...result.guardrails, ...source.guardrails };
    }

    if (source.providers) {
      result.providers = { ...result.providers };
      for (const [name, providerConfig] of Object.entries(source.providers)) {
        result.providers[name] = {
          ...(result.providers[name] ?? {}),
          ...providerConfig,
        };
      }
    }
  }

  result.defaultModel = resolveDefaultModel(result);
  return result;
}

function resolveDefaultModel(config: AgenticConfig): string {
  const providerConfig = config.providers[config.defaultProvider];
  if (providerConfig?.model) {
    return providerConfig.model;
  }
  if (config.defaultModel) {
    return config.defaultModel;
  }
  switch (config.defaultProvider) {
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'ollama':
      return OLLAMA_DEFAULT_MODEL;
    default:
      return ANTHROPIC_DEFAULT_MODEL;
  }
}

function applyProviderApiKeysFromEnv(config: AgenticConfig, env: NodeJS.ProcessEnv): void {
  const anthropicKey = readEnv(env, 'ANTHROPIC_API_KEY');
  const openaiKey = readEnv(env, 'OPENAI_API_KEY');
  const ollamaUrl = readEnv(env, 'OLLAMA_BASE_URL');

  if (anthropicKey) {
    config.providers.anthropic = { ...config.providers.anthropic, apiKey: anthropicKey };
  }
  if (openaiKey) {
    config.providers.openai = { ...config.providers.openai, apiKey: openaiKey };
  }
  if (ollamaUrl) {
    config.providers.ollama = { ...config.providers.ollama, baseUrl: ollamaUrl };
  }
}

function validateAgenticConfig(
  config: AgenticConfig,
  warnings: ConfigWarning[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!config.defaultProvider.trim()) {
    issues.push({
      code: 'missing_required',
      message: 'defaultProvider must be a non-empty string',
      path: 'defaultProvider',
    });
  } else if (!KNOWN_PROVIDERS.has(config.defaultProvider.toLowerCase())) {
    warnings.push({
      code: 'unknown_provider',
      message: `defaultProvider "${config.defaultProvider}" is not a built-in provider (anthropic, openai, ollama)`,
      path: 'defaultProvider',
    });
  }

  if (!config.defaultModel.trim()) {
    issues.push({
      code: 'missing_required',
      message: 'defaultModel must be a non-empty string',
      path: 'defaultModel',
    });
  }

  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) {
    issues.push({
      code: 'invalid_value',
      message: 'maxSteps must be a positive integer',
      path: 'maxSteps',
    });
  }

  if (config.maxTokenBudget !== undefined && config.maxTokenBudget < 1) {
    issues.push({
      code: 'invalid_value',
      message: 'maxTokenBudget must be a positive integer when set',
      path: 'maxTokenBudget',
    });
  }

  if (!LOG_LEVELS.has(config.logLevel)) {
    issues.push({
      code: 'invalid_value',
      message: `logLevel must be one of: ${[...LOG_LEVELS].join(', ')}`,
      path: 'logLevel',
    });
  }

  if (!TELEMETRY_EXPORTERS.has(config.telemetry.exporter)) {
    warnings.push({
      code: 'unknown_exporter',
      message: `telemetry.exporter "${config.telemetry.exporter}" is not a built-in exporter (console, memory, none)`,
      path: 'telemetry.exporter',
    });
  }

  if (config.guardrails.maxCostUsd !== undefined && config.guardrails.maxCostUsd < 0) {
    issues.push({
      code: 'invalid_value',
      message: 'guardrails.maxCostUsd must be >= 0 when set',
      path: 'guardrails.maxCostUsd',
    });
  }

  return issues;
}

function collectEnvWarnings(env: NodeJS.ProcessEnv, warnings: ConfigWarning[]): void {
  const logLevelRaw = readEnv(env, 'AGENTIC_LOG_LEVEL');
  if (logLevelRaw && !parseLogLevel(logLevelRaw)) {
    warnings.push({
      code: 'invalid_env_value',
      message: `AGENTIC_LOG_LEVEL "${logLevelRaw}" is invalid; expected debug, info, warn, error, or silent`,
      path: 'AGENTIC_LOG_LEVEL',
    });
  }

  const maxStepsRaw = readEnv(env, 'AGENTIC_MAX_STEPS');
  if (maxStepsRaw && parsePositiveInt(maxStepsRaw) === undefined) {
    warnings.push({
      code: 'invalid_env_value',
      message: `AGENTIC_MAX_STEPS "${maxStepsRaw}" is not a positive integer`,
      path: 'AGENTIC_MAX_STEPS',
    });
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseLogLevel(value: string | undefined): AgenticLogLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase() as AgenticLogLevel;
  return LOG_LEVELS.has(normalized) ? normalized : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveFloat(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve API key for a provider from merged config. */
export function resolveProviderApiKey(
  config: AgenticConfig,
  providerName: string,
): string | undefined {
  return config.providers[providerName]?.apiKey;
}
