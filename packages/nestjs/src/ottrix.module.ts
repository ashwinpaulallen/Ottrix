import {
  DynamicModule,
  Module,
  Provider,
} from '@nestjs/common';
import { Agent } from 'ottrix/agent';
import { ToolRegistry } from 'ottrix/tools';
import { DAGWorkflow } from 'ottrix/orchestration';
import type {
  OttrixFeatureOptions,
  OttrixModuleAsyncOptions,
  OttrixModuleOptions,
  OttrixOptionsFactory,
} from './interfaces.js';
import {
  agentToken,
  featureToolsToken,
  OTTRIX_GUARDRAIL_SERVICE,
  OTTRIX_MODULE_OPTIONS,
  OTTRIX_MCP_REGISTRY,
  OTTRIX_PROVIDER_REGISTRY,
  OTTRIX_RUN_CONTEXT,
  OTTRIX_TELEMETRY,
  OTTRIX_TOOL_REGISTRY,
  providerToken,
  workflowToken,
} from './tokens.js';
import { ProviderRegistryService } from './services/provider-registry.service.js';
import { TelemetryService } from './services/telemetry.service.js';
import { ToolRegistryService } from './services/tool-registry.service.js';
import { RunContextService } from './services/run-context.service.js';
import { GuardrailService } from './services/guardrail.service.js';
import { InjectionGuard } from './guards/injection.guard.js';
import { BudgetGuard } from './guards/budget.guard.js';
import { TelemetryInterceptor } from './interceptors/telemetry.interceptor.js';
import { RunContextInterceptor } from './interceptors/run-context.interceptor.js';
import { OttrixHealthIndicator } from './health/ottrix.health.js';

const CORE_SERVICES = [
  ProviderRegistryService,
  TelemetryService,
  ToolRegistryService,
  RunContextService,
  GuardrailService,
  InjectionGuard,
  BudgetGuard,
  TelemetryInterceptor,
  RunContextInterceptor,
  OttrixHealthIndicator,
] as const;

/**
 * Global NestJS module integrating Ottrix agents, tools, telemetry, and guardrails.
 */
@Module({})
export class OttrixModule {
  /** Register Ottrix with synchronous configuration. */
  static forRoot(options: OttrixModuleOptions): DynamicModule {
    return {
      module: OttrixModule,
      global: true,
      providers: [
        { provide: OTTRIX_MODULE_OPTIONS, useValue: options },
        ...CORE_SERVICES,
        ...createProviderTokens(),
        ...createRegistryProviders(),
      ],
      exports: [
        OTTRIX_MODULE_OPTIONS,
        ProviderRegistryService,
        TelemetryService,
        ToolRegistryService,
        RunContextService,
        GuardrailService,
        InjectionGuard,
        BudgetGuard,
        TelemetryInterceptor,
        RunContextInterceptor,
        OttrixHealthIndicator,
        OTTRIX_TOOL_REGISTRY,
        OTTRIX_TELEMETRY,
        OTTRIX_PROVIDER_REGISTRY,
        OTTRIX_RUN_CONTEXT,
        OTTRIX_MCP_REGISTRY,
        OTTRIX_GUARDRAIL_SERVICE,
      ],
    };
  }

  /** Register Ottrix with async configuration (ConfigService, secrets managers, etc.). */
  static forRootAsync(options: OttrixModuleAsyncOptions): DynamicModule {
    const asyncProviders = createAsyncProviders(options);

    return {
      module: OttrixModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        ...CORE_SERVICES,
        ...createRegistryProviders(),
        ...createProviderTokens(),
      ],
      exports: [
        OTTRIX_MODULE_OPTIONS,
        ProviderRegistryService,
        TelemetryService,
        ToolRegistryService,
        RunContextService,
        GuardrailService,
        InjectionGuard,
        BudgetGuard,
        TelemetryInterceptor,
        RunContextInterceptor,
        OttrixHealthIndicator,
        OTTRIX_TOOL_REGISTRY,
        OTTRIX_TELEMETRY,
        OTTRIX_PROVIDER_REGISTRY,
        OTTRIX_RUN_CONTEXT,
        OTTRIX_MCP_REGISTRY,
        OTTRIX_GUARDRAIL_SERVICE,
      ],
    };
  }

  /** Register feature-scoped agents, tools, and workflows. */
  static forFeature(options: OttrixFeatureOptions): DynamicModule {
    const toolsToken = featureToolsToken();
    return {
      module: OttrixModule,
      providers: [
        ...createToolProviders(options, toolsToken),
        ...createAgentProviders(options, toolsToken),
        ...createWorkflowProviders(options),
      ],
      exports: [
        ...(options.agents?.map((agent) => agentToken(agent.name)) ?? []),
        ...(options.workflows?.map((workflow) => workflowToken(workflow.name)) ?? []),
      ],
    };
  }
}

function createRegistryProviders(): Provider[] {
  return [
    {
      provide: OTTRIX_TOOL_REGISTRY,
      useFactory: (service: ToolRegistryService): ToolRegistry => service.getRegistry(),
      inject: [ToolRegistryService],
    },
    {
      provide: OTTRIX_MCP_REGISTRY,
      useFactory: (service: ToolRegistryService) => service.getMcpRegistry(),
      inject: [ToolRegistryService],
    },
    {
      provide: OTTRIX_TELEMETRY,
      useExisting: TelemetryService,
    },
    {
      provide: OTTRIX_PROVIDER_REGISTRY,
      useExisting: ProviderRegistryService,
    },
    {
      provide: OTTRIX_RUN_CONTEXT,
      useExisting: RunContextService,
    },
    {
      provide: OTTRIX_GUARDRAIL_SERVICE,
      useExisting: GuardrailService,
    },
  ];
}

function createProviderTokens(): Provider[] {
  const standardNames = ['anthropic', 'openai', 'ollama'];
  return standardNames.map((name) => ({
    provide: providerToken(name),
    useFactory: (registry: ProviderRegistryService) => registry.getOptional(name),
    inject: [ProviderRegistryService],
  }));
}

function createToolProviders(options: OttrixFeatureOptions, toolsToken: symbol): Provider[] {
  if (!options.tools?.length) {
    return [];
  }

  return [
    {
      provide: toolsToken,
      useFactory: (toolRegistryService: ToolRegistryService) => {
        for (const definition of options.tools ?? []) {
          toolRegistryService.getRegistry().register(definition.tool);
        }
        return true;
      },
      inject: [ToolRegistryService],
    },
  ];
}

function createAgentProviders(options: OttrixFeatureOptions, toolsToken: symbol): Provider[] {
  const hasTools = (options.tools?.length ?? 0) > 0;

  return (options.agents ?? []).map((definition) => ({
    provide: agentToken(definition.name),
    useFactory: (
      providerRegistry: ProviderRegistryService,
      toolRegistryService: ToolRegistryService,
      guardrails: GuardrailService,
      telemetry: TelemetryService,
    ) => {
      const provider = definition.provider
        ? providerRegistry.get(definition.provider)
        : providerRegistry.getRegistry();

      return new Agent({
        name: definition.name,
        provider,
        toolRegistry: buildAgentToolRegistry(toolRegistryService.getRegistry(), definition.tools),
        systemPrompt: definition.systemPrompt,
        defaultModel: definition.model,
        maxSteps: definition.maxSteps,
        maxTokenBudget: definition.maxTokenBudget,
        telemetry: telemetry.getTelemetry(),
        guardrailMiddleware: guardrails.createForAgent(definition.name),
      });
    },
    inject: hasTools
      ? [
          ProviderRegistryService,
          ToolRegistryService,
          GuardrailService,
          TelemetryService,
          toolsToken,
        ]
      : [ProviderRegistryService, ToolRegistryService, GuardrailService, TelemetryService],
  }));
}

function buildAgentToolRegistry(globalRegistry: ToolRegistry, toolNames?: string[]): ToolRegistry {
  if (!toolNames || toolNames.length === 0) {
    return globalRegistry;
  }

  const scoped = new ToolRegistry();
  const missing: string[] = [];
  for (const name of toolNames) {
    const tool = globalRegistry.get(name);
    if (tool) {
      scoped.register(tool);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Agent references unknown tools: ${missing.join(', ')}`);
  }
  return scoped;
}

function createWorkflowProviders(options: OttrixFeatureOptions): Provider[] {
  return (options.workflows ?? []).map((definition) => ({
    provide: workflowToken(definition.name),
    useFactory: () => {
      if (definition.workflow) {
        return definition.workflow;
      }
      if (!definition.config) {
        throw new Error(
          `Workflow "${definition.name}" requires either workflow or config in forFeature()`,
        );
      }
      return new DAGWorkflow(definition.config);
    },
  }));
}

function createAsyncProviders(options: OttrixModuleAsyncOptions): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: OTTRIX_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
    ];
  }

  if (options.useClass) {
    return [
      { provide: options.useClass, useClass: options.useClass },
      {
        provide: OTTRIX_MODULE_OPTIONS,
        useFactory: (factory: OttrixOptionsFactory) => factory.createOttrixOptions(),
        inject: [options.useClass],
      },
    ];
  }

  if (options.useExisting) {
    return [
      {
        provide: OTTRIX_MODULE_OPTIONS,
        useFactory: (factory: OttrixOptionsFactory) => factory.createOttrixOptions(),
        inject: [options.useExisting],
      },
    ];
  }

  throw new Error('OttrixModule.forRootAsync requires useFactory, useClass, or useExisting');
}
