import type { ModuleMetadata, Type } from '@nestjs/common';
import type { Agent } from 'ottrix/agent';
import type { BaseTool } from 'ottrix/tools';
import type { DAGWorkflow, DAGWorkflowConfig } from 'ottrix/orchestration';

/** Provider configuration for Ottrix LLM backends. */
export interface OttrixProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Telemetry exporter configuration. */
export interface OttrixTelemetryConfig {
  exporter: 'langfuse' | 'otel' | 'console' | 'webhook';
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
  };
  otel?: {
    endpoint: string;
    protocol?: 'grpc' | 'http';
    headers?: Record<string, string>;
    serviceName?: string;
  };
  webhook?: {
    url: string;
    headers?: Record<string, string>;
  };
}

/** Guardrail configuration for the NestJS module. */
export interface OttrixGuardrailsConfig {
  injection?: {
    mode?: 'block' | 'flag' | 'sanitize';
    strictness?: 'low' | 'medium' | 'high';
  };
  pii?: {
    mode?: 'block' | 'flag' | 'tokenize';
  };
  budget?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxSteps?: number;
  };
}

/** Root module configuration for {@link OttrixModule.forRoot}. */
export interface OttrixModuleOptions {
  providers: {
    chain?: string[];
    anthropic?: OttrixProviderConfig;
    openai?: OttrixProviderConfig;
    ollama?: OttrixProviderConfig;
  };
  telemetry?: OttrixTelemetryConfig;
  guardrails?: OttrixGuardrailsConfig;
  /** Enable AsyncLocalStorage-backed RunContext. @defaultValue true */
  runContext?: boolean;
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
}

/** Agent definition for {@link OttrixModule.forFeature}. */
export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  /** Registered provider name from {@link OttrixModuleOptions.providers}. */
  provider?: string;
  model?: string;
  /** Tool names registered in the global {@link ToolRegistry}. */
  tools?: string[];
  maxSteps?: number;
  maxTokenBudget?: number;
}

/** Tool definition for feature registration. */
export interface ToolDefinition {
  tool: BaseTool;
}

/** Workflow definition for feature registration. */
export interface WorkflowDefinition {
  name: string;
  /** Pre-built workflow instance. */
  workflow?: DAGWorkflow;
  /** Workflow config used to construct a {@link DAGWorkflow} on init. */
  config?: DAGWorkflowConfig;
}

/** Feature-scoped configuration for {@link OttrixModule.forFeature}. */
export interface OttrixFeatureOptions {
  agents?: AgentDefinition[];
  tools?: ToolDefinition[];
  workflows?: WorkflowDefinition[];
}

/** Resolved agent handle stored in the DI container. */
export type ResolvedAgent = Agent;

/** Resolved workflow handle stored in the DI container. */
export type ResolvedWorkflow = DAGWorkflow;
