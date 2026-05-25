import { NoSuchModelError } from '@ai-sdk/provider';
import type { Provider } from 'ai';
import type { ProviderRegistry } from 'ottrix';

import { createOttrixModel } from './model.js';

/** Callable Vercel AI SDK provider backed by ottrix's {@link ProviderRegistry}. */
export type OttrixProvider = Provider & ((modelId: string) => ReturnType<typeof createOttrixModel>);

/**
 * Create a Vercel AI SDK {@link Provider} from ottrix's registry.
 *
 * Fallback chains, circuit breakers, and cost tracking on the registry apply automatically.
 */
export function createOttrixProvider(registry: ProviderRegistry): OttrixProvider {
  const provider: Provider = {
    languageModel(modelId: string) {
      return createOttrixModel(registry, { modelId, providerName: 'ottrix' });
    },
    embeddingModel(modelId: string) {
      throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
    },
    imageModel(modelId: string) {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
    },
    rerankingModel(modelId: string) {
      throw new NoSuchModelError({ modelId, modelType: 'rerankingModel' });
    },
  };

  const callable = ((modelId: string) => provider.languageModel(modelId)) as OttrixProvider;
  return Object.assign(callable, provider);
}
