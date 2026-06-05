import type { ModuleMetadata, Type } from '@nestjs/common';
import type { AgenticTelemetryConfig, BaseTool, CreateAgentConfig } from 'ottrix';
import type { ContextExtractors } from 'ottrix/http';
import type { OttrixToolFactory } from './tools/ottrix-tool.provider.js';
import type { SessionMemoryServiceOptions } from './session/session-memory.js';

/** Provider configuration for Ottrix LLM backends. */
export interface OttrixProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** OTEL exporter settings (NestJS shorthand when `exporter: 'otel'`). */
export interface OttrixOtelConfig {
  endpoint: string;
  protocol?: 'grpc' | 'http';
  headers?: Record<string, string>;
  serviceName?: string;
}

/**
 * Telemetry configuration for {@link OttrixModule.forRoot}.
 *
 * Extends core {@link AgenticTelemetryConfig} with an `otel` shorthand block.
 */
export type OttrixTelemetryConfig = Omit<AgenticTelemetryConfig, 'exporter' | 'enabled'> & {
  enabled?: boolean;
  exporter: AgenticTelemetryConfig['exporter'] | 'otel';
  otel?: OttrixOtelConfig;
};

/**
 * HTTP integration for {@link OttrixModule.forRoot}.
 *
 * - `true` — enable RunContext, telemetry spans, and injection guard
 * - `false` — disable all automatic HTTP wiring
 * - object — enable individual features (defaults: runContext + telemetry on, injectionGuard off)
 */
export type OttrixHttpOptions =
  | boolean
  | {
      runContext?: boolean | RunContextInterceptorOptions;
      telemetry?: boolean;
      injectionGuard?: boolean | InjectionGuardOptions;
      /** Enable CORS headers on {@link OttrixController} OPTIONS handler. @defaultValue `true` when `http: true` */
      cors?: boolean;
    };

/** Root module configuration for {@link OttrixModule.forRoot}. */
export interface OttrixModuleOptions {
  providers: {
    chain?: string[];
    anthropic?: OttrixProviderConfig;
    openai?: OttrixProviderConfig;
    ollama?: OttrixProviderConfig;
  };
  telemetry?: OttrixTelemetryConfig;
  /**
   * Wire Ottrix HTTP interceptors and guards globally via Nest `APP_*` tokens.
   *
   * @defaultValue `{ runContext: true, telemetry: true }` — injection guard is opt-in
   */
  http?: OttrixHttpOptions;
  /**
   * Session-scoped conversation memory for chat pipelines.
   * @defaultValue disabled — enable with `true` or a custom store.
   */
  sessionMemory?: boolean | SessionMemoryServiceOptions;
}

/** Factory interface for async module configuration. */
export interface OttrixOptionsFactory {
  createOttrixOptions(): Promise<OttrixModuleOptions> | OttrixModuleOptions;
}

/** Async configuration for {@link OttrixModule.forRootAsync}. */
export interface OttrixModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: unknown[]) => Promise<OttrixModuleOptions> | OttrixModuleOptions;
  inject?: Array<Type<unknown> | string | symbol>;
  useClass?: Type<OttrixOptionsFactory>;
  useExisting?: Type<OttrixOptionsFactory>;
  /**
   * HTTP wiring — set on `forRootAsync` (not inside `useFactory`) so Nest can register `APP_*` tokens.
   *
   * @defaultValue `{ runContext: true, telemetry: true }`
   */
  http?: OttrixHttpOptions;
}

/** Agent definition for {@link OttrixModule.forFeature} — args for {@link createAgent}. */
export type AgentDefinition = Omit<CreateAgentConfig, 'tools'> & {
  name: string;
  /** Tool instances or names registered on {@link OTTRIX_TOOL_REGISTRY}. */
  tools?: BaseTool[] | readonly string[];
};

/** Feature-scoped configuration for {@link OttrixModule.forFeature}. */
export interface OttrixFeatureOptions {
  agents?: AgentDefinition[];
  /**
   * NestJS provider classes decorated with {@link OttrixTool} that implement
   * {@link OttrixToolFactory}. Registered on the global tool registry before agents resolve.
   */
  tools?: Array<Type<OttrixToolFactory>>;
  /** Register {@link OttrixController} with the feature module. */
  controller?: boolean;
  /** Route prefix for {@link OttrixController}. @defaultValue `'chat'` */
  controllerPath?: string;
}

/** Options for {@link RunContextInterceptor}. */
export type RunContextInterceptorOptions = Partial<ContextExtractors>;

/** Options for {@link InjectionGuard}. */
export interface InjectionGuardOptions {
  /** Body field to scan. @defaultValue `'message'` */
  bodyField?: string;
  /** @defaultValue `'block'` */
  mode?: 'block' | 'flag';
}

/** Resolved HTTP feature flags used internally by {@link OttrixModule}. */
export interface ResolvedOttrixHttpOptions {
  runContext: boolean | RunContextInterceptorOptions;
  telemetry: boolean;
  injectionGuard: boolean | InjectionGuardOptions;
  cors: boolean;
}
