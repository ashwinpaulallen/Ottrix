export { OttrixModule } from './ottrix.module.js';

export type {
  OttrixModuleOptions,
  OttrixModuleAsyncOptions,
  OttrixFeatureOptions,
  OttrixOptionsFactory,
  OttrixProviderConfig,
  OttrixTelemetryConfig,
  OttrixOtelConfig,
  OttrixHttpOptions,
  ResolvedOttrixHttpOptions,
  AgentDefinition,
  RunContextInterceptorOptions,
  InjectionGuardOptions,
} from './interfaces.js';

export {
  InjectAgent,
  InjectProvider,
  InjectToolRegistry,
  InjectTelemetry,
} from './decorators.js';

export {
  OTTRIX_MODULE_OPTIONS,
  OTTRIX_TOOL_REGISTRY,
  OTTRIX_TELEMETRY,
  OTTRIX_PROVIDER_REGISTRY,
  OTTRIX_PROVIDER_NAMES,
  OTTRIX_RUN_CONTEXT_OPTIONS,
  OTTRIX_HTTP_OPTIONS,
  OTTRIX_INJECTION_GUARD_OPTIONS,
  agentToken,
  providerToken,
} from './tokens.js';

export { OttrixLifecycleService } from './lifecycle/ottrix-lifecycle.service.js';

export { resolveHttpOptions, createHttpProviders } from './setup/http-providers.js';

export { InjectionGuard } from './guards/injection.guard.js';

export { TelemetryInterceptor } from './interceptors/telemetry.interceptor.js';
export { RunContextInterceptor } from './interceptors/run-context.interceptor.js';

export {
  createSseStream,
  type SseMessageEvent,
  type CreateSseStreamOptions,
} from './helpers/sse.js';

export {
  OttrixHealthIndicator,
  OttrixHealthCheckError,
  type OttrixHealthIndicatorResult,
} from './health/ottrix.health.js';

export { OttrixExceptionFilter } from './filters/ottrix-exception.filter.js';

export { OttrixController, createOttrixController } from './controllers/ottrix.controller.js';

export { mapOttrixError } from 'ottrix/http';
