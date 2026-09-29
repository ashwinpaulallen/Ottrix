import type { CompletionProvider } from '../../types/provider.js';
import { ProviderError } from '../errors.js';
import { ProviderRegistry } from '../registry.js';
import {
  ModelDescriptorSchema,
  type CompletionIntent,
  type IntentResolutionResult,
  type ModelCatalogConfig,
  type ModelDescriptor,
} from './types.js';

/** In-memory catalog that resolves a {@link CompletionIntent} to a provider and model. */
export class ModelCatalog {
  private readonly models = new Map<string, ModelDescriptor>();
  private readonly intentMap: Record<string, string>;

  constructor(
    private readonly registry: ProviderRegistry,
    config?: ModelCatalogConfig,
  ) {
    this.intentMap = config?.intentMap ?? {};
    for (const model of config?.models ?? []) {
      this.register(model);
    }
  }

  /** Validate and store a model descriptor, replacing any entry with the same key. */
  register(descriptor: ModelDescriptor): void {
    const validated = ModelDescriptorSchema.parse(descriptor);
    this.models.set(validated.key, validated);
  }

  /**
   * Resolve an intent to a concrete provider and model.
   *
   * Explicit `intentMap` entries win. Otherwise candidates are filtered by
   * `requires` and ranked by role preference and the `prefer` dimension.
   */
  resolve(intent: CompletionIntent): IntentResolutionResult {
    const intentKey = `${intent.role}:${intent.prefer}`;
    const mappedKey = this.intentMap[intentKey] ?? this.intentMap[intent.role];
    if (mappedKey) {
      const descriptor = this.models.get(mappedKey);
      if (descriptor) {
        return this.buildResult(
          descriptor,
          `explicit intent map: ${intentKey} → ${mappedKey}`,
          intent,
        );
      }
    }

    let candidates = Array.from(this.models.values());
    if (intent.requires?.tools) {
      candidates = candidates.filter((model) => model.supportsTools);
    }
    if (intent.requires?.vision) {
      candidates = candidates.filter((model) => model.supportsVision);
    }
    if (intent.requires?.streaming) {
      candidates = candidates.filter((model) => model.supportsStreaming);
    }
    const minContextTokens = intent.requires?.minContextTokens;
    if (minContextTokens !== undefined) {
      candidates = candidates.filter(
        (model) => !model.contextTokens || model.contextTokens >= minContextTokens,
      );
    }

    if (candidates.length === 0) {
      throw new CatalogResolutionError(
        `No model satisfies intent: ${JSON.stringify(intent)}`,
        intent,
      );
    }

    const scored = candidates.map((model) => ({ model, score: this.score(model, intent) }));
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0]?.model;
    if (!winner) {
      throw new CatalogResolutionError(
        `No model satisfies intent: ${JSON.stringify(intent)}`,
        intent,
      );
    }

    return this.buildResult(
      winner,
      `scored: role=${intent.role} prefer=${intent.prefer}`,
      intent,
    );
  }

  /** Registered descriptors in insertion order. */
  list(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }

  private score(model: ModelDescriptor, intent: CompletionIntent): number {
    let score = 0;

    if (model.preferredFor?.includes(intent.role)) {
      score += 10;
    }

    switch (intent.prefer) {
      case 'speed':
        if (model.speedTier === 'fast') {
          score += 5;
        }
        break;
      case 'economy':
        if (model.costTier === 'low' || model.costTier === 'free') {
          score += 5;
        }
        break;
      case 'quality':
        if (model.qualityTier === 'frontier') {
          score += 5;
        }
        break;
      case 'balanced':
        score += 2;
        break;
      default:
        break;
    }

    return score;
  }

  private buildResult(
    descriptor: ModelDescriptor,
    reason: string,
    intent: CompletionIntent,
  ): IntentResolutionResult {
    let provider: CompletionProvider;
    try {
      provider = this.registry.get(descriptor.provider);
    } catch (error) {
      if (ProviderError.isProviderError(error)) {
        throw new CatalogResolutionError(
          `Catalog references provider '${descriptor.provider}' which is not registered`,
          intent,
        );
      }
      throw error;
    }

    return { descriptor, provider, model: descriptor.model, reason };
  }
}

/** Thrown when an intent cannot be resolved to a registered provider and model. */
export class CatalogResolutionError extends Error {
  constructor(
    message: string,
    public readonly intent: CompletionIntent,
  ) {
    super(message);
    this.name = 'CatalogResolutionError';
  }
}

/** Create an in-memory {@link ModelCatalog}. */
export function createModelCatalog(
  registry: ProviderRegistry,
  config?: ModelCatalogConfig,
): ModelCatalog {
  return new ModelCatalog(registry, config);
}
