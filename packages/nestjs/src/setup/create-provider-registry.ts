import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  ProviderRegistry,
} from 'ottrix';
import type { Telemetry, TraceExporter } from 'ottrix';
import type { OttrixModuleOptions } from '../interfaces.js';

/** Create and configure a {@link ProviderRegistry} from module options. */
export function createProviderRegistry(
  options: OttrixModuleOptions,
  telemetry: Telemetry,
): { registry: ProviderRegistry; names: string[] } {
  const registry = new ProviderRegistry({ telemetry });
  const names: string[] = [];

  const { providers } = options;

  if (providers.anthropic?.apiKey) {
    registry.register(
      'anthropic',
      createAnthropicProvider({
        apiKey: providers.anthropic.apiKey,
        model: providers.anthropic.model,
      }),
    );
    names.push('anthropic');
  }

  if (providers.openai?.apiKey) {
    registry.register(
      'openai',
      createOpenAIProvider({
        apiKey: providers.openai.apiKey,
        baseUrl: providers.openai.baseUrl,
        model: providers.openai.model,
      }),
    );
    names.push('openai');
  }

  if (providers.ollama) {
    registry.register(
      'ollama',
      createOllamaProvider({
        baseUrl: providers.ollama.baseUrl,
        model: providers.ollama.model,
      }),
    );
    names.push('ollama');
  }

  if (providers.chain && providers.chain.length > 0) {
    registry.setFallbackChain(providers.chain);
    if (names.length === 0) {
      throw new Error('OttrixModule: fallback chain configured but no providers registered');
    }
  } else if (names.length > 0) {
    registry.setDefault(names[0]);
  }

  return { registry, names };
}
