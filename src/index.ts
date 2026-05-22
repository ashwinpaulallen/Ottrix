/** Matches `package.json` version — update both when releasing. */
export const AGENTIC_FABRIC_VERSION = '2.0.0' as const;

/** @deprecated Use {@link AGENTIC_FABRIC_VERSION}. */
export const AGENT_FABRIC_VERSION = AGENTIC_FABRIC_VERSION;

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
  MCPServer,
  serveMCP,
  ASK_AGENT_TOOL_NAME,
} from './tools/index.js';

export type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalHandler,
  ToolExecuteOptions,
} from './types/tools.js';

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
  InMemoryStateStore,
  WorkflowLoader,
  LoadedWorkflow,
} from './orchestration/index.js';

// --- Guardrails ---
export {
  createGuardrails,
  GuardrailMiddleware,
  PromptInjectionGuardrail,
  type CreateGuardrailsConfig,
  type CreateGuardrailsResult,
  type InjectionDetection,
  type PromptInjectionGuardrailOptions,
} from './guardrails/index.js';

// --- Observability ---
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
  LangfuseExporter,
  BraintrustExporter,
  WebhookExporter,
  TraceConsoleExporter,
  InMemoryTraceExporter,
  MultiExporter,
  buildTraceData,
  createTraceExporterFromConfig,
  configureTraceExportFromConfig,
  type TraceExporter,
  type TraceData,
} from './observability/index.js';

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
