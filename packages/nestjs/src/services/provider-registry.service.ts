import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  ProviderRegistry,
} from 'ottrix/providers';
import type { CompletionProvider } from 'ottrix/types';
import type { OttrixModuleOptions } from '../interfaces.js';
import { OTTRIX_MODULE_OPTIONS } from '../tokens.js';
import { TelemetryService } from './telemetry.service.js';

/** NestJS-managed {@link ProviderRegistry} with lifecycle hooks. */
@Injectable()
export class ProviderRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly registry: ProviderRegistry;
  private readonly registeredNames: string[] = [];

  constructor(
    @Inject(OTTRIX_MODULE_OPTIONS) private readonly options: OttrixModuleOptions,
    private readonly telemetryService: TelemetryService,
  ) {
    this.registry = new ProviderRegistry({ telemetry: this.telemetryService.getTelemetry() });
  }

  onModuleInit(): void {
    this.configureProviders();
  }

  onModuleDestroy(): void {
    // ProviderRegistry has no persistent connections; noop.
  }

  /** Underlying Ottrix provider registry. */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  /** Resolve a registered provider by name. */
  get(name: string): CompletionProvider {
    return this.registry.get(name);
  }

  /** Resolve a registered provider by name, or undefined when not registered. */
  getOptional(name: string): CompletionProvider | undefined {
    try {
      return this.registry.get(name);
    } catch {
      return undefined;
    }
  }

  /** Whether a provider is registered and healthy. */
  isHealthy(name: string): boolean {
    try {
      return this.registry.isHealthy(name);
    } catch {
      return false;
    }
  }

  /** List registered provider names. */
  listNames(): string[] {
    return [...this.registeredNames];
  }

  /** Ping providers that expose health checks (e.g. Ollama). */
  async pingProviders(): Promise<Record<string, { healthy: boolean; detail?: string }>> {
    const results: Record<string, { healthy: boolean; detail?: string }> = {};

    for (const name of this.listNames()) {
      try {
        const provider = this.registry.get(name);
        if ('healthCheck' in provider && typeof provider.healthCheck === 'function') {
          const status = await (
            provider as { healthCheck: () => Promise<{ ok?: boolean; status?: string }> }
          ).healthCheck();
          const healthy = status.ok !== false;
          results[name] = { healthy, detail: status.status };
          this.registry.setHealthy(name, healthy);
        } else {
          results[name] = { healthy: this.registry.isHealthy(name) };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[name] = { healthy: false, detail: message };
        try {
          this.registry.setHealthy(name, false);
        } catch {
          // Provider may have been removed.
        }
      }
    }

    return results;
  }

  private configureProviders(): void {
    const { providers } = this.options;
    const configured: string[] = [];

    if (providers.anthropic?.apiKey) {
      this.registry.register(
        'anthropic',
        createAnthropicProvider({
          apiKey: providers.anthropic.apiKey,
          model: providers.anthropic.model,
        }),
      );
      configured.push('anthropic');
      this.registeredNames.push('anthropic');
    }

    if (providers.openai?.apiKey) {
      this.registry.register(
        'openai',
        createOpenAIProvider({
          apiKey: providers.openai.apiKey,
          baseUrl: providers.openai.baseUrl,
          model: providers.openai.model,
        }),
      );
      configured.push('openai');
      this.registeredNames.push('openai');
    }

    if (providers.ollama) {
      this.registry.register(
        'ollama',
        createOllamaProvider({
          baseUrl: providers.ollama.baseUrl,
          model: providers.ollama.model,
        }),
      );
      configured.push('ollama');
      this.registeredNames.push('ollama');
    }

    if (providers.chain && providers.chain.length > 0) {
      this.registry.setFallbackChain(providers.chain);
      if (configured.length === 0) {
        throw new Error('OttrixModule: fallback chain configured but no providers registered');
      }
    } else if (configured.length > 0) {
      this.registry.setDefault(configured[0]);
    }
  }
}
