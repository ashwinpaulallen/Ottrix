/** Matches `package.json` version — update both when releasing. */
export const OTTRIX_VERSION = '2.1.0' as const;

/** @deprecated Use {@link OTTRIX_VERSION}. */
export const AGENT_KIT_VERSION = OTTRIX_VERSION;

/** @deprecated Use {@link OTTRIX_VERSION}. */
export const AGENTIC_FABRIC_VERSION = OTTRIX_VERSION;

/** @deprecated Use {@link OTTRIX_VERSION}. */
export const AGENT_FABRIC_VERSION = OTTRIX_VERSION;

// --- Run context (AsyncLocalStorage propagation) ---
export {
  runWith,
  runGeneratorWith,
  getRunContext,
  requireRunContext,
  withStep,
  invokeWithRunContext,
  ContextNotAvailableError,
  RunContext,
} from './context/index.js';

// --- Core types (explicit exports avoid bundler type collisions) ---
export type {
  AgentConfig,
  AgentResult,
  AgentRunMetadata,
  AgentRunOptions,
  AgentStep,
  AgentStepType,
  AgentStopReason,
  AgentEvent,
  AgentToolRegistry,
  AgentErrorAction,
} from './types/agent.js';

export { StructuredOutputError } from './agent/structured-output.js';
export {
  zodToJsonSchema,
  ensureZodPeer,
  ZOD_REQUIRED_MESSAGE,
} from './utils/zod-to-json-schema.js';

export { sha256, canonicalStringify } from './utils/hash.js';

export type {
  ChatMessage,
  ChatRole,
  ContentBlock,
  TextBlock,
  CompletionProvider,
  CompletionParams,
  CompletionResult,
  TokenUsage,
  StreamChunk,
} from './types/index.js';

// --- Convenience API ---
export {
  createAgent,
  quickAgent,
  resetCreateAgentDefaults,
  type CreateAgentConfig,
  type QuickAgentOptions,
  type ProviderName,
} from './factory.js';

export {
  readAgenticEnv,
  getAgenticEnv,
  configToAgenticEnv,
  resetAgenticEnvCache,
  resolveApiKey,
  type AgenticEnv,
  type AgenticProviderName,
} from './env.js';

export {
  loadConfig,
  defineConfig,
  getConfig,
  setConfig,
  resetConfigCache,
  discoverConfigFile,
  readConfigFromEnv,
  mergeAgenticConfig,
  resolveProviderApiKey,
  isBuiltInProviderName,
  DEFAULT_AGENTIC_CONFIG,
  ConfigValidationError,
  type AgenticConfig,
  type AgenticConfigInput,
  type AgenticProviderConfig,
  type AgenticGuardrailsConfig,
  type AgenticLogLevel,
  type AgenticTelemetryConfig,
  type AgenticTelemetryExporter,
  type BuiltInProviderName,
  type LoadConfigOptions,
  type LoadConfigResult,
  type ConfigWarning,
  type ConfigIssue,
  /** @deprecated Use {@link AgenticProviderConfig} */
  type ProviderConfig,
} from './config.js';

// --- Core agent ---
export { Agent } from './agent/agent.js';
export {
  Planner,
  Reflector,
  ContextManager,
  mergeRevisedPlan,
  parsePlanFromJson,
  evaluateResultLightweight,
  evaluateStepLightweight,
  shouldContinueLightweight,
  checkRunGuardrails,
  sumTokenUsage,
  buildAssistantMessage,
  buildToolResultBlock,
  buildToolResultsMessage,
  extractTextFromContent,
  extractToolUses,
  isTextOnlyResponse,
  serializeToolOutput,
  createEvaluator,
  CompositeEvaluator,
  HeuristicEvaluator,
  LLMEvaluator,
  buildRefinementInstruction,
  SufficiencyResultSchema,
  EvaluationConfigSchema,
  type Plan,
  type PlanStep,
  type PlanValidationResult,
  type PlannerMode,
  type PlannerOptions,
  type PlanningRule,
  type ReflectorOptions,
  type ResultEvaluation,
  type StepEvaluation,
  type GuardrailCheckResult,
  type SufficiencyResult,
  type EvaluationConfig,
  type EvaluationRecord,
  type EvaluatorStrategy,
  type EvaluationContext,
} from './agent/index.js';

// --- Providers ---
export {
  createAnthropicProvider,
  createOpenAIProvider,
  createOllamaProvider,
  ProviderRegistry,
  CircuitBreaker,
  CircuitOpenError,
  computeFallbackBackoffMs,
  computeProviderBackoffMs,
  classifyProviderError,
  isProviderCircuitOpen,
  isProviderRequestBlocked,
  shouldTryFallback,
  normalizeFallbackChain,
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
  ProviderError,
  AggregateProviderError,
  BaseProvider,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_BASE_URL,
  type BaseProviderConfig,
} from './providers/index.js';

// --- Tools ---
export {
  FunctionTool,
  ZodTool,
  createTool,
  isZodTool,
  BaseTool,
  ToolRegistry,
  ToolNotFoundError,
  DuplicateToolError,
  ToolValidationError,
  ConfigurationError,
  createCliApprovalHandler,
  createAutoApproveHandler,
  createCallbackApprovalHandler,
  isToolApprovalDenied,
  buildToolApprovalDenialMessage,
  MCPClient,
  MCPToolProvider,
  MCPTool,
  MCPRegistry,
  createMCPTool,
  defaultMcpToolClassifier,
  classifyMcpToolMetadata,
  buildToolDescriptor,
  normalizeToolMetadata,
  useIdempotencyStore,
  getIdempotencyStore,
  resetIdempotencyStore,
  InMemoryIdempotencyStore,
  TOOL_IDEMPOTENCY_IN_PROGRESS_NAME,
} from './tools/index.js';

export type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalHandler,
  ToolExecuteOptions,
  ToolMetadata,
  ApprovalRequirement,
  AuditConfig,
  ToolDescriptor,
  ToolDescriptorSafety,
  ToolAuditEvent,
} from './types/tools.js';

export type { ToolAuditHandler } from './tools/index.js';

// --- Memory ---
export {
  WorkingMemory,
  SemanticMemory,
  EpisodicMemory,
  ObservationalMemory,
  InMemoryObservationStore,
  InMemoryVectorStore,
  NoOpEmbeddingProvider,
  FetchEmbeddingProvider,
} from './memory/index.js';

// --- Orchestration ---
export {
  SequentialWorkflow,
  ParallelWorkflow,
  ParallelThenWorkflow,
  RouterWorkflow,
  HierarchicalWorkflow,
  SupervisorWorkflow,
  createSupervisor,
  DAGWorkflow,
  DAGBuilder,
  agentStep,
  functionStep,
  parallelStep,
  CyclicDependencyError,
  DAGStepTimeoutError,
  DAGWorkflowCancelledError,
  WorkflowResumeError,
  WorkflowSuspendedError,
  WorkflowStateLockError,
  StateStorePeerDependencyError,
  InMemoryStateStore,
  PostgresStateStore,
  RedisStateStore,
  WorkflowLoader,
  LoadedWorkflow,
} from './orchestration/index.js';

// --- Guardrails ---
export {
  createGuardrails,
  configureBudgets,
  getConfiguredBudgets,
  GuardrailMiddleware,
  BudgetGuardrail,
  InMemoryBudgetStore,
  PromptInjectionGuardrail,
  AuditEmitter,
  ConsoleSink,
  InMemorySink,
  FileSink,
  HmacSigner,
  useAudit,
  getAuditEmitter,
  resetAudit,
  type CreateGuardrailsConfig,
  type CreateGuardrailsResult,
  type BudgetConfig,
  type BudgetScope,
  type BudgetCap,
  type BudgetUsageStore,
  type AuditEvent,
  type AuditEventType,
  type AuditSink,
  type AuditSigner,
  type AuditEmitterConfig,
  type InjectionDetection,
  type PromptInjectionGuardrailOptions,
} from './guardrails/index.js';

// --- Observability ---
// Langfuse exporter: npm install @ottrix/exporter-langfuse
// Braintrust exporter: npm install @ottrix/exporter-braintrust
// OTel exporter: npm install @ottrix/exporter-otel
// MCP server: npm install @ottrix/mcp-server
export {
  Logger,
  Telemetry,
  RunRecorder,
  getTelemetry,
  setTelemetry,
  getLogger,
  setLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  ConsoleExporter,
  InMemoryExporter,
  WebhookExporter,
  TraceConsoleExporter,
  InMemoryTraceExporter,
  MultiExporter,
  buildTraceData,
  createTraceExporterFromConfig,
  configureTraceExportFromConfig,
  shutdownObservability,
  resetGlobalObservability,
  type TraceExporter,
  type TraceData,
  type ExportSpanData as SpanData,
  type WebhookExporterOptions,
} from './observability/index.js';

// --- Token accounting (per-capability attribution) ---
export { TokenAccumulator } from './observability/token-accounting/accumulator.js';
export {
  withTokenAccounting,
  getTokenAccumulator,
  recordTokens,
  withCapabilityScope,
  enterCapabilityScope,
} from './observability/token-accounting/context.js';
export {
  formatTokenBreakdown,
  formatTokenBreakdownTable,
} from './observability/token-accounting/formatter.js';
export { attachCosts } from './observability/token-accounting/cost-attribution.js';
export { CAPABILITY } from './observability/token-accounting/types.js';
export type {
  TokenBreakdown,
  CapabilityUsage,
  TokenRecord,
} from './observability/token-accounting/types.js';

// --- Evals ---
export {
  evaluate,
  EvalRunner,
  EvalReporter,
  computeAggregates,
  aggregateScores,
  ExactMatchScorer,
  ContainsScorer,
  JsonValidityScorer,
  SchemaMatchScorer,
  RelevanceScorer,
  CorrectnessScorer,
  HelpfulnessScorer,
  type EvalRunnerOptions,
  type EvalReporterOptions,
  type Scorer,
} from './evals/index.js';

export type {
  EvalDatasetEntry,
  EvalResult,
  ScoreResult,
  EvalReport,
  AggregateScore,
  EvalRunConfig,
} from './evals/index.js';

// --- Remaining shared types (tools, memory, guardrails, etc.) ---
export type {
  ToolDefinition,
  ToolResult,
  ToolExecutor,
  JSONSchema,
  MemoryProvider,
  MemoryEntry,
  GuardrailConfig,
} from './types/index.js';
