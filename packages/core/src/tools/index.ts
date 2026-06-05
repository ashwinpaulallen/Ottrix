export {
  BaseTool,
  DEFAULT_TOOL_TIMEOUT_MS,
  ToolValidationError,
  extractErrorDetails,
  type BaseToolConfig,
  type ToolExecutionEvent,
  type ToolExecutionErrorEvent,
  type ToolExecutionEvents,
  type ToolExecutionResultEvent,
} from './tool.js';

export { FunctionTool, type FunctionToolConfig, type ToolExecuteFn } from './function-tool.js';

export {
  ZodTool,
  createTool,
  isZodTool,
  type ZodToolConfig,
  type AnyZodSchema,
} from './zod-tool.js';

export { ConfigurationError } from './errors.js';

export {
  DuplicateToolError,
  ToolNotFoundError,
  ToolRegistry,
  type ToolAuditHandler,
  type ToolRegistryOnDuplicate,
  type ToolRegistryRegisterOptions,
} from './registry.js';

export {
  DEFAULT_TOOL_SAFETY,
  MCP_APPROVAL_NAME_PATTERN,
  MCP_DESTRUCTIVE_NAME_PATTERN,
  TOOL_SAFETY_BLOCKED_NAME,
  applyAuditFilter,
  buildSafetyBlockedResult,
  buildToolDescriptor,
  classifyMcpToolMetadata,
  defaultMcpToolClassifier,
  normalizeToolMetadata,
  requiresApprovalEnabled,
  resolveSandboxAvailable,
  warnDestructiveWithoutApproval,
  type ToolSafetyFields,
} from './tool-safety.js';

export {
  createCliApprovalHandler,
  createAutoApproveHandler,
  createCallbackApprovalHandler,
} from './approval-handlers.js';

export {
  TOOL_APPROVAL_DENIED_PREFIX,
  TOOL_APPROVAL_DENIED_NAME,
  isToolApprovalDenied,
  getToolApprovalDenialReason,
  buildToolApprovalDenialMessage,
  buildToolApprovalDeniedResult,
} from './tool-approval.js';

export {
  buildIdempotencyInProgressResult,
  computeIdempotencyKey,
  generateDefaultIdempotencyKey,
  getIdempotencyOptions,
  getIdempotencyStore,
  isIdempotentTool,
  resetIdempotencyStore,
  resolveIdempotencyStore,
  useIdempotencyStore,
  waitForIdempotencyResult,
  InMemoryIdempotencyStore,
  TOOL_IDEMPOTENCY_IN_PROGRESS_NAME,
  DEFAULT_IDEMPOTENCY_MAX_ATTEMPTS,
  DEFAULT_IDEMPOTENCY_WAIT_MS,
  type IdempotencyCheckResult,
  type IdempotencyExecutionOptions,
  type IdempotencyKeyContext,
  type IdempotencyKeyFn,
  type IdempotencyStore,
  type InMemoryIdempotencyStoreOptions,
} from './idempotency.js';

export { type IdempotencyToolFields } from './zod-tool.js';

export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './mcp/types.js';
export type { MCPTransport } from './mcp/transport.js';

export {
  MCP_PROTOCOL_VERSION,
  MCPClient,
  MCPProtocolError,
  MCPRegistry,
  MCPTool,
  MCPToolProvider,
  SseMCPTransport,
  SseParser,
  StdioMCPTransport,
  createMCPTool,
  type MCPClientInfo,
  type MCPClientOptions,
  type MCPConnectionState,
  type MCPImportToolsOptions,
  type MCPInitializeResult,
  type MCPReconnectOptions,
  type MCPRegistryServerOptions,
  type MCPServerConfig,
  type MCPSseServerConfig,
  type MCPStdioServerConfig,
  type MCPToolConfig,
  type MCPToolDefinition,
  type MCPToolProviderOptions,
} from './mcp.js';

export { validateSchema, type SchemaValidationResult } from '../utils/schema-validator.js';

export {
  defineToolRegistry,
  pickTools,
  isToolNameArray,
  type ToolRegistryDefinition,
  type ToolNames,
} from './tool-registry-builder.js';
