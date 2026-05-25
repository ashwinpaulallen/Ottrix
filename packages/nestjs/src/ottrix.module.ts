import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  createAgent,
  getTelemetry,
  ToolRegistry,
  type CompletionProvider,
  type ProviderName,
  type ProviderRegistry,
} from 'ottrix';
import type {
  OttrixFeatureOptions,
  OttrixModuleAsyncOptions,
  OttrixModuleOptions,
  OttrixOptionsFactory,
} from './interfaces.js';
import {
  agentToken,
  OTTRIX_MODULE_OPTIONS,
  OTTRIX_PROVIDER_NAMES,
  OTTRIX_PROVIDER_REGISTRY,
  OTTRIX_TELEMETRY,
  OTTRIX_TOOL_REGISTRY,
  providerToken,
} from './tokens.js';
import { OttrixLifecycleService } from './lifecycle/ottrix-lifecycle.service.js';
import { createProviderRegistry } from './setup/create-provider-registry.js';
import { createHttpProviders } from './setup/http-providers.js';
import { InjectionGuard } from './guards/injection.guard.js';
import { TelemetryInterceptor } from './interceptors/telemetry.interceptor.js';
import { RunContextInterceptor } from './interceptors/run-context.interceptor.js';
import { OttrixHealthIndicator } from './health/ottrix.health.js';

const CORE_PROVIDERS = [
  OttrixLifecycleService,
  InjectionGuard,
  TelemetryInterceptor,
  RunContextInterceptor,
  OttrixHealthIndicator,
] as const;

/** Global NestJS module bridging Ottrix into dependency injection and HTTP lifecycle. */
@Module({})
export class OttrixModule {
  /** Register Ottrix with synchronous configuration. */
  static forRoot(options: OttrixModuleOptions): DynamicModule {
    return {
      module: OttrixModule,
      global: true,
      providers: [
        { provide: OTTRIX_MODULE_OPTIONS, useValue: options },
        ...createRegistryProviders(),
        ...createNamedProviderTokens(),
        ...CORE_PROVIDERS,
        ...createHttpProviders(options.http),
      ],
      exports: createRootExports(),
    };
  }

  /** Register Ottrix with async configuration (ConfigService, secrets managers, etc.). */
  static forRootAsync(options: OttrixModuleAsyncOptions): DynamicModule {
    return {
      module: OttrixModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...createAsyncProviders(options),
        ...createRegistryProviders(),
        ...createNamedProviderTokens(),
        ...CORE_PROVIDERS,
        ...createHttpProviders(options.http),
      ],
      exports: createRootExports(),
    };
  }

  /** Register feature-scoped agents from declarative {@link createAgent} config. */
  static forFeature(options: OttrixFeatureOptions): DynamicModule {
    return {
      module: OttrixModule,
      providers: createAgentProviders(options),
      exports: options.agents?.map((agent) => agentToken(agent.name)) ?? [],
    };
  }
}

const OTTRIX_PROVIDER_SETUP = Symbol('OTTRIX_PROVIDER_SETUP');

function createRootExports() {
  return [
    OTTRIX_MODULE_OPTIONS,
    OTTRIX_TOOL_REGISTRY,
    OTTRIX_TELEMETRY,
    OTTRIX_PROVIDER_REGISTRY,
    OTTRIX_PROVIDER_NAMES,
    InjectionGuard,
    TelemetryInterceptor,
    RunContextInterceptor,
    OttrixHealthIndicator,
    OttrixLifecycleService,
    ...['anthropic', 'openai', 'ollama'].map((name) => providerToken(name)),
  ];
}

function createRegistryProviders(): Provider[] {
  return [
    {
      provide: OTTRIX_TOOL_REGISTRY,
      useFactory: () => new ToolRegistry({ telemetry: getTelemetry() }),
    },
    {
      provide: OTTRIX_TELEMETRY,
      useFactory: () => getTelemetry(),
    },
    {
      provide: OTTRIX_PROVIDER_SETUP,
      useFactory: (moduleOptions: OttrixModuleOptions) =>
        createProviderRegistry(moduleOptions, getTelemetry()),
      inject: [OTTRIX_MODULE_OPTIONS],
    },
    {
      provide: OTTRIX_PROVIDER_REGISTRY,
      useFactory: (setup: { registry: ProviderRegistry; names: string[] }) => setup.registry,
      inject: [OTTRIX_PROVIDER_SETUP],
    },
    {
      provide: OTTRIX_PROVIDER_NAMES,
      useFactory: (setup: { registry: ProviderRegistry; names: string[] }) => setup.names,
      inject: [OTTRIX_PROVIDER_SETUP],
    },
  ];
}

function createNamedProviderTokens(): Provider[] {
  return ['anthropic', 'openai', 'ollama'].map((name) => ({
    provide: providerToken(name),
    useFactory: (registry: ProviderRegistry) => {
      try {
        return registry.get(name);
      } catch {
        return undefined;
      }
    },
    inject: [OTTRIX_PROVIDER_REGISTRY],
  }));
}

function createAgentProviders(options: OttrixFeatureOptions): Provider[] {
  return (options.agents ?? []).map((definition) => ({
    provide: agentToken(definition.name),
    useFactory: (registry: ProviderRegistry) => {
      const { name, ...createConfig } = definition;
      return createAgent({
        ...createConfig,
        name,
        provider: resolveAgentProvider(registry, createConfig.provider),
        telemetry: getTelemetry(),
      });
    },
    inject: [OTTRIX_PROVIDER_REGISTRY],
  }));
}

function resolveAgentProvider(
  registry: ProviderRegistry,
  provider?: ProviderName | CompletionProvider,
): CompletionProvider {
  if (provider === undefined) {
    return registry;
  }
  if (typeof provider === 'string') {
    return registry.get(provider);
  }
  return provider;
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
