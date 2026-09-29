import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  CatalogResolutionError,
  ModelCatalog,
  ModelDescriptorSchema,
} from '../../../src/providers/index.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import type { CompletionProvider } from '../../../src/types/provider.js';
import type { CompletionIntent, ModelDescriptor } from '../../../src/providers/intent/types.js';

function stubProvider(): CompletionProvider {
  return {
    complete: async () => {
      throw new Error('unused');
    },
    stream: async function* () {
      yield { type: 'done', data: { stopReason: 'stop' } };
    },
    countTokens: async () => 0,
  };
}

function model(overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'key' | 'model'>): ModelDescriptor {
  return ModelDescriptorSchema.parse({
    provider: 'anthropic',
    displayName: overrides.key,
    ...overrides,
  });
}

function catalogWith(
  models: ModelDescriptor[],
  intentMap?: Record<string, string>,
  registry = new ProviderRegistry().register('anthropic', stubProvider()),
): ModelCatalog {
  return new ModelCatalog(registry, { models, intentMap });
}

describe('ModelCatalog', () => {
  it('resolves a model from an explicit intent map', () => {
    const opus = model({ key: 'claude-opus', model: 'claude-opus-4', qualityTier: 'frontier' });
    const haiku = model({ key: 'haiku', model: 'claude-haiku', costTier: 'low' });
    const catalog = catalogWith([opus, haiku], { 'summarization:economy': 'haiku' });

    const result = catalog.resolve({ role: 'summarization', prefer: 'economy' });

    expect(result.descriptor.key).toBe('haiku');
    expect(result.model).toBe('claude-haiku');
    expect(result.reason).toBe('explicit intent map: summarization:economy → haiku');
  });

  it('filters candidates that do not support tools', () => {
    const chat = model({ key: 'chat', model: 'chat-v1', supportsTools: false, qualityTier: 'frontier' });
    const tools = model({ key: 'tools', model: 'tools-v1', supportsTools: true, qualityTier: 'basic' });
    const catalog = catalogWith([chat, tools]);

    const result = catalog.resolve({ role: 'reasoning', prefer: 'quality', requires: { tools: true } });

    expect(result.descriptor.key).toBe('tools');
  });

  it('filters candidates that do not support vision', () => {
    const text = model({ key: 'text', model: 'text-v1', supportsVision: false });
    const vision = model({ key: 'vision', model: 'vision-v1', supportsVision: true });
    const catalog = catalogWith([text, vision]);

    const result = catalog.resolve({ role: 'extraction', prefer: 'balanced', requires: { vision: true } });

    expect(result.descriptor.key).toBe('vision');
  });

  it('prefers a model tagged for the intent role', () => {
    const general = model({ key: 'general-model', model: 'general-v1', qualityTier: 'frontier' });
    const summarizer = model({
      key: 'summarizer',
      model: 'summary-v1',
      qualityTier: 'basic',
      preferredFor: ['summarization'],
    });
    const catalog = catalogWith([general, summarizer]);

    const result = catalog.resolve({ role: 'summarization', prefer: 'quality' });

    expect(result.descriptor.key).toBe('summarizer');
    expect(result.reason).toBe('scored: role=summarization prefer=quality');
  });

  it('selects a low-cost model when prefer is economy', () => {
    const frontier = model({
      key: 'frontier',
      model: 'frontier-v1',
      costTier: 'high',
      qualityTier: 'frontier',
    });
    const cheap = model({ key: 'cheap', model: 'cheap-v1', costTier: 'low', qualityTier: 'basic' });
    const catalog = catalogWith([frontier, cheap]);

    const result = catalog.resolve({ role: 'general', prefer: 'economy' });

    expect(result.descriptor.key).toBe('cheap');
  });

  it('throws CatalogResolutionError when no model satisfies requirements', () => {
    const catalog = catalogWith([
      model({ key: 'text', model: 'text-v1', supportsVision: false }),
    ]);
    const intent: CompletionIntent = { role: 'extraction', prefer: 'balanced', requires: { vision: true } };

    expect(() => catalog.resolve(intent)).toThrow(CatalogResolutionError);
    expect(() => catalog.resolve(intent)).toThrow(/No model satisfies intent/);
  });

  it('throws CatalogResolutionError when the provider is not registered', () => {
    const registry = new ProviderRegistry();
    const catalog = new ModelCatalog(registry, {
      models: [model({ key: 'orphan', model: 'orphan-v1', provider: 'missing' })],
    });

    expect(() => catalog.resolve({ role: 'general', prefer: 'balanced' })).toThrow(CatalogResolutionError);
    expect(() => catalog.resolve({ role: 'general', prefer: 'balanced' })).toThrow(
      /provider 'missing' which is not registered/,
    );
  });

  it('validates descriptors with Zod on register', () => {
    const catalog = new ModelCatalog(new ProviderRegistry());

    expect(() => catalog.register({ displayName: 'incomplete' } as ModelDescriptor)).toThrow(ZodError);
    expect(catalog.list()).toEqual([]);
  });

  it('lists every registered model', () => {
    const first = model({ key: 'first', model: 'first-v1' });
    const second = model({ key: 'second', model: 'second-v1' });
    const catalog = catalogWith([first]);
    catalog.register(second);

    expect(catalog.list().map((entry) => entry.key)).toEqual(['first', 'second']);
  });
});
