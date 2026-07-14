import { Agent } from './agent/agent.js';
import type { AgentConfig } from './types/agent.js';
import type { CompletionProvider } from './types/provider.js';
import type { MemoryEntry, MemoryProvider, RetrievalOptions } from './types/memory.js';
import {
  createAnthropicProvider,
  createOpenAIProvider,
  createOllamaProvider,
  ProviderError,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
} from './providers/index.js';
import { ToolRegistry } from './tools/registry.js';
import type { BaseTool } from './tools/tool.js';
import { getIdempotencyStore } from './tools/idempotency.js';
import { createGuardrails, type CreateGuardrailsConfig } from './guardrails/factory.js';
import { getTelemetry, setLogger } from './observability/global.js';
import { Logger, setGlobalLogLevel } from './observability/logger.js';
import { configureTraceExportFromConfig } from './observability/exporters/index.js';
import type { Telemetry } from './observability/telemetry.js';
import type { AgenticProviderName } from './env.js';
import {
  isBuiltInProviderName,
  loadConfig,
  markCreateAgentDefaultsApplied,
  resetCreateAgentDefaultsState,
  resolveProviderApiKey,
  wereCreateAgentDefaultsApplied,
  type AgenticConfig,
  type AgenticConfigInput,
} from './config.js';

/** Provider shorthand accepted by {@link createAgent} and {@link quickAgent}. */
export type ProviderName = AgenticProviderName;

/** Simplified configuration for {@link createAgent}. */
export interface CreateAgentConfig
  extends Pick<
    AgentConfig,
    | 'systemPrompt'
    | 'maxSteps'
    | 'maxTokenBudget'
    | 'onStep'
    | 'onToolCall'
    | 'onError'
    | 'planner'
    | 'reflector'
    | 'evaluation'
    | 'contextLimitTokens'
    | 'keepRecentMessages'
    | 'defaultModel'
    | 'runRecorder'
  > {
  /** Agent name for logging and telemetry. @defaultValue `'agent'` */
  name?: string;
  /**
   * LLM backend — provider name or a pre-built {@link CompletionProvider}.
   * Names resolve via {@link createAnthropicProvider}, {@link createOpenAIProvider}, or
   * {@link createOllamaProvider}. Falls back to `AGENTIC_PROVIDER` when omitted.
   */
  provider?: ProviderName | CompletionProvider;
  /** API key (falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). */
  apiKey?: string;
  /** OpenAI-compatible or Ollama base URL. */
  baseUrl?: string;
  /** Model id (falls back to `AGENTIC_MODEL` or provider default). */
  model?: string;
  /** Tools registered on a new {@link ToolRegistry}. */
  tools?: BaseTool[];
  /**
   * Session memory for retrieval-augmented prompts.
   * @defaultValue `true` — lightweight in-memory keyword store
   */
  /** @defaultValue `true` — pass `false` to disable retrieval memory */
  memory?: boolean | MemoryProvider;
  /**
   * Tracing and metrics.
   * @defaultValue `true` — uses the global {@link Telemetry} instance
   */
  telemetry?: boolean | Telemetry;
  /**
   * Guardrail middleware and budgets.
   * @defaultValue `true` — PII detection and step/token budgets
   */
  guardrails?: boolean | CreateGuardrailsConfig;
}

/** Options for {@link quickAgent}. */
export type QuickAgentOptions = Pick<
  CreateAgentConfig,
  'provider' | 'apiKey' | 'baseUrl' | 'model' | 'systemPrompt' | 'maxSteps' | 'tools' | 'memory' | 'telemetry' | 'guardrails'
>;

/** Reset one-time logger/telemetry setup applied by {@link createAgent} (for tests). */
export function resetCreateAgentDefaults(): void {
  resetCreateAgentDefaultsState();
}

function toConfigOverrides(config: CreateAgentConfig): AgenticConfigInput {
  const overrides: AgenticConfigInput = {};

  if (typeof config.provider === 'string') {
    overrides.defaultProvider = config.provider;
  }
  if (config.model) {
    overrides.defaultModel = config.model;
  }
  if (config.maxSteps !== undefined) {
    overrides.maxSteps = config.maxSteps;
  }
  if (config.maxTokenBudget !== undefined) {
    overrides.maxTokenBudget = config.maxTokenBudget;
  }

  if (
    typeof config.provider !== 'object' &&
    (config.apiKey || config.baseUrl || config.model)
  ) {
    const providerName =
      typeof config.provider === 'string' ? config.provider : 'anthropic';
    overrides.providers = {
      [providerName]: {
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.model ? { model: config.model } : {}),
      },
    };
  }

  if (config.telemetry === false) {
    overrides.telemetry = { enabled: false };
  }

  return overrides;
}

/**
 * Build an {@link Agent} from a simplified configuration object.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   provider: 'anthropic',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   model: 'claude-sonnet-4-20250514',
 *   tools: [myTool],
 *   systemPrompt: 'You are helpful.',
 * });
 * const result = await agent.run('Hello');
 * ```
 */
export function createAgent(config: CreateAgentConfig = {}): Agent {
  const { config: agentic } = loadConfig({ overrides: toConfigOverrides(config) });
  applyConfigDefaults(agentic);

  const name = config.name ?? 'agent';
  const providerName = resolveProviderName(config.provider, agentic);
  const model =
    config.model ??
    agentic.providers[providerName]?.model ??
    agentic.defaultModel ??
    defaultModelFor(providerName);
  const maxSteps = config.maxSteps ?? agentic.maxSteps;

  assertBuiltInProvider(providerName, config.provider);

  const provider = resolveProvider(config, providerName, model, agentic);
  const toolRegistry = buildToolRegistry(config.tools, name, resolveTelemetry(config, agentic));
  const evaluationProvider = resolveEvaluationProvider(
    config,
    providerName,
    model,
    agentic,
  );

  const agentConfig: AgentConfig = {
    name,
    provider,
    toolRegistry,
    systemPrompt: config.systemPrompt,
    defaultModel: config.defaultModel ?? model,
    maxSteps,
    maxTokenBudget: config.maxTokenBudget ?? agentic.maxTokenBudget,
    onStep: config.onStep,
    onToolCall: config.onToolCall,
    onError: config.onError,
    planner: config.planner,
    reflector: config.reflector,
    evaluation: config.evaluation,
    evaluationProvider,
    contextLimitTokens: config.contextLimitTokens ?? 128_000,
    keepRecentMessages: config.keepRecentMessages ?? 6,
    runRecorder: config.runRecorder,
    memory: resolveMemory(config.memory),
    telemetry: resolveTelemetry(config, agentic),
  };

  const guardrails = resolveGuardrails(config, name, providerName, maxSteps, agentic);
  if (guardrails) {
    agentConfig.guardrailMiddleware = guardrails.middleware;
    agentConfig.guardrails = guardrails.config;
  }

  return new Agent(agentConfig);
}

/**
 * Run a one-off prompt with sensible defaults.
 *
 * @example
 * ```ts
 * const answer = await quickAgent('What is 2+2?', { provider: 'anthropic' });
 * ```
 */
export async function quickAgent(prompt: string, options: QuickAgentOptions = {}): Promise<string> {
  const agent = createAgent({
    name: 'quick',
    systemPrompt: options.systemPrompt ?? 'You are a helpful assistant.',
    ...options,
  });
  const result = await agent.run(prompt);
  return result.response;
}

function applyConfigDefaults(agentic: AgenticConfig): void {
  if (wereCreateAgentDefaultsApplied()) {
    return;
  }
  markCreateAgentDefaultsApplied();

  if (agentic.logLevel !== 'silent') {
    setGlobalLogLevel(agentic.logLevel);
    setLogger(new Logger({ component: 'ottrix', level: agentic.logLevel }));
  }

  configureTraceExportFromConfig(agentic.telemetry);
}

function resolveProviderName(
  provider: CreateAgentConfig['provider'],
  agentic: AgenticConfig,
): ProviderName {
  if (typeof provider === 'string') {
    return provider;
  }
  if (provider) {
    return inferProviderName() ?? (agentic.defaultProvider as ProviderName);
  }
  return agentic.defaultProvider as ProviderName;
}

function inferProviderName(): ProviderName | undefined {
  return undefined;
}

function assertBuiltInProvider(
  providerName: string,
  providerOption: CreateAgentConfig['provider'],
): void {
  if (providerOption && typeof providerOption !== 'string') {
    return;
  }
  if (!isBuiltInProviderName(providerName)) {
    throw new Error(
      `createAgent: unknown provider "${providerName}". ` +
        'Use "anthropic", "openai", or "ollama", or pass a CompletionProvider instance.',
    );
  }
}

function defaultModelFor(provider: ProviderName): string {
  switch (provider) {
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'ollama':
      return OLLAMA_DEFAULT_MODEL;
    default:
      return ANTHROPIC_DEFAULT_MODEL;
  }
}

function resolveProvider(
  config: CreateAgentConfig,
  providerName: ProviderName,
  model: string,
  agentic: AgenticConfig,
): CompletionProvider {
  if (config.provider && typeof config.provider !== 'string') {
    return config.provider;
  }

  const providerSettings = agentic.providers[providerName];

  switch (providerName) {
    case 'anthropic': {
      const apiKey =
        config.apiKey ?? providerSettings?.apiKey ?? resolveProviderApiKey(agentic, 'anthropic');
      if (!apiKey) {
        throw new ProviderError(
          'createAgent: anthropic provider requires apiKey or ANTHROPIC_API_KEY',
          { code: 'auth', retryable: false },
        );
      }
      return createAnthropicProvider({ apiKey, model });
    }
    case 'openai': {
      const apiKey =
        config.apiKey ?? providerSettings?.apiKey ?? resolveProviderApiKey(agentic, 'openai');
      if (!apiKey) {
        throw new ProviderError(
          'createAgent: openai provider requires apiKey or OPENAI_API_KEY',
          { code: 'auth', retryable: false },
        );
      }
      return createOpenAIProvider({
        apiKey,
        model,
        baseUrl: config.baseUrl ?? providerSettings?.baseUrl,
      });
    }
    case 'ollama':
      return createOllamaProvider({
        model,
        baseUrl: config.baseUrl ?? providerSettings?.baseUrl,
      });
    default:
      throw new Error(`createAgent: unsupported provider "${providerName as string}"`);
  }
}

/**
 * When evaluation uses a different model, build a secondary provider with the
 * same credentials so eval calls don't share the main agent's default model.
 * Custom CompletionProvider instances cannot be cloned — the evaluator still
 * passes `evaluation.model` on each complete() call in that case.
 */
function resolveEvaluationProvider(
  config: CreateAgentConfig,
  providerName: ProviderName,
  mainModel: string,
  agentic: AgenticConfig,
): CompletionProvider | undefined {
  const evalModel = config.evaluation?.enabled ? config.evaluation.model : undefined;
  if (!evalModel || evalModel === mainModel) {
    return undefined;
  }
  if (config.provider && typeof config.provider !== 'string') {
    return undefined;
  }
  return resolveProvider({ ...config, model: evalModel }, providerName, evalModel, agentic);
}

function buildToolRegistry(
  tools: BaseTool[] | undefined,
  component: string,
  telemetry: Telemetry | undefined,
): ToolRegistry | undefined {
  if (!tools?.length) {
    return undefined;
  }
  const registry = new ToolRegistry({
    telemetry,
    component,
    idempotencyStore: getIdempotencyStore(),
  });
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

function resolveTelemetry(
  config: CreateAgentConfig,
  agentic: AgenticConfig,
): Telemetry | undefined {
  if (config.telemetry === false || !agentic.telemetry.enabled) {
    return undefined;
  }
  if (config.telemetry && typeof config.telemetry === 'object') {
    return config.telemetry;
  }
  return getTelemetry();
}

function resolveMemory(memory: CreateAgentConfig['memory']): MemoryProvider | undefined {
  if (memory === false || memory === undefined) {
    return memory === false ? undefined : createDefaultMemory();
  }
  if (memory === true) {
    return createDefaultMemory();
  }
  return memory;
}

function resolveGuardrails(
  config: CreateAgentConfig,
  agentName: string,
  providerName: ProviderName,
  maxSteps: number,
  agentic: AgenticConfig,
) {
  if (config.guardrails === false) {
    return undefined;
  }
  const options: CreateGuardrailsConfig =
    config.guardrails === true || config.guardrails === undefined
      ? {
          agentName,
          providerName,
          budget: {
            maxSteps,
            maxTokenBudget: config.maxTokenBudget ?? agentic.maxTokenBudget,
            maxCostUsd: agentic.guardrails.maxCostUsd,
          },
          pii: { blockOnDetect: agentic.guardrails.piiDetection },
        }
      : {
          agentName,
          providerName,
          ...config.guardrails,
          budget: {
            maxSteps,
            maxTokenBudget: config.maxTokenBudget ?? agentic.maxTokenBudget,
            maxCostUsd: agentic.guardrails.maxCostUsd,
            ...config.guardrails.budget,
          },
          pii: {
            blockOnDetect: agentic.guardrails.piiDetection,
            ...(config.guardrails.pii ?? {}),
          },
        };
  return createGuardrails(options);
}

/** Lightweight in-memory store for quick-start retrieval. */
function createDefaultMemory(): MemoryProvider {
  return new KeywordMemoryProvider();
}

class KeywordMemoryProvider implements MemoryProvider {
  private readonly entries: MemoryEntry[] = [];

  store(entry: MemoryEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  retrieve(query: string, options?: RetrievalOptions): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 5;
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 1);
    if (terms.length === 0) {
      return Promise.resolve(this.entries.slice(-limit));
    }

    const scored = this.entries
      .map((entry) => ({
        entry,
        score: terms.reduce(
          (sum, term) => sum + (entry.content.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return Promise.resolve(scored.slice(0, limit).map((row) => row.entry));
  }

  clear(): Promise<void> {
    this.entries.length = 0;
    return Promise.resolve();
  }
}
