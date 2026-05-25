import { createAgent, createAnthropicProvider, ProviderRegistry } from 'ottrix';

/** Shared agent + registry for runnable HTTP adapter examples. */
export function createExampleSetup() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const registry = new ProviderRegistry();
  registry.register('anthropic', createAnthropicProvider({ apiKey }));
  registry.setDefault('anthropic');

  const agent = createAgent({
    provider: 'anthropic',
    apiKey,
    systemPrompt: 'You are a helpful assistant.',
  });

  return { agent, registry };
}
