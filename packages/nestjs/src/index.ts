export { OttrixModule } from './ottrix.module.js';

export type {
  OttrixModuleOptions,
  OttrixModuleAsyncOptions,
  OttrixFeatureOptions,
  OttrixOptionsFactory,
  OttrixProviderConfig,
  OttrixTelemetryConfig,
  OttrixGuardrailsConfig,
  AgentDefinition,
  ToolDefinition,
  WorkflowDefinition,
} from './interfaces.js';

export {
  InjectAgent,
  InjectWorkflow,
  InjectProvider,
  InjectToolRegistry,
  InjectTelemetry,
} from './decorators.js';

export {
  OTTRIX_MODULE_OPTIONS,
  OTTRIX_TOOL_REGISTRY,
  OTTRIX_TELEMETRY,
  OTTRIX_PROVIDER_REGISTRY,
  OTTRIX_GUARDRAIL_SERVICE,
  OTTRIX_RUN_CONTEXT,
  OTTRIX_MCP_REGISTRY,
  agentToken,
  workflowToken,
  providerToken,
} from './tokens.js';

export { ProviderRegistryService } from './services/provider-registry.service.js';
export { TelemetryService } from './services/telemetry.service.js';
export { ToolRegistryService } from './services/tool-registry.service.js';
export { RunContextService } from './services/run-context.service.js';
export { GuardrailService } from './services/guardrail.service.js';

export { InjectionGuard } from './guards/injection.guard.js';
export { BudgetGuard } from './guards/budget.guard.js';

export { TelemetryInterceptor } from './interceptors/telemetry.interceptor.js';
export { RunContextInterceptor } from './interceptors/run-context.interceptor.js';

export { createSseHandler, type SseMessageEvent, type SseHandlerOptions } from './helpers/sse.js';

export {
  OttrixHealthIndicator,
  OttrixHealthCheckError,
  type OttrixHealthIndicatorResult,
} from './health/ottrix.health.js';
