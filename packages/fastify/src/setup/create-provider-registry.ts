import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  ProviderRegistry,
  type Telemetry,
} from 'ottrix';

/** Provider configuration for {@link ottrixPlugin}. */
export interface OttrixProviderOptions {
  chain?: string[];
  anthropic?: { apiKey?: string; model?: string };
  openai?: { apiKey?: string; baseUrl?: string; model?: string };
  ollama?: { baseUrl?: string; model?: string };
}

/** Create and configure a {@link ProviderRegistry} from plugin options. */
export function createProviderRegistry(
  providers: OttrixProviderOptions | undefined,
  telemetry: Telemetry,
): ProviderRegistry {
  const registry = new ProviderRegistry({ telemetry });
  const names: string[] = [];

  if (!providers) {
    return registry;
  }

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
      throw new Error('@ottrix/fastify: fallback chain configured but no providers registered');
    }
  } else if (names.length > 0) {
    registry.setDefault(names[0]!);
  }

  return registry;
}
