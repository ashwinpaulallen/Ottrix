import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { CompositeEvaluator } from '../src/agent/evaluation/composite-evaluator.js';
import { createAgent } from '../src/factory.js';
import { resetConfigCache } from '../src/config.js';
import { MockCompletionProvider, textCompletion } from './fixtures/mock-provider.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const substantiveAnswer =
  'The capital of France is Paris. It has been the political and cultural center for centuries.';

function evalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: true,
    confidence: 0.95,
    reason: 'Fully answers the question',
    suggestedAction: 'finalize',
    ...overrides,
  });
}

describe('createAgent evaluation wiring', () => {
  afterEach(() => {
    resetConfigCache();
  });

  it('createAgent without evaluation → evaluation is undefined, no evaluator', () => {
    const provider = new MockCompletionProvider();
    const agent = createAgent({
      provider,
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    expect(agent.getEvaluationConfig()).toBeUndefined();
    expect(agent.getEvaluator()).toBeUndefined();
  });

  it('createAgent with evaluation: { enabled: true } → creates CompositeEvaluator', () => {
    const provider = new MockCompletionProvider();
    const agent = createAgent({
      provider,
      evaluation: { enabled: true },
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    expect(agent.getEvaluator()).toBeInstanceOf(CompositeEvaluator);
    expect(agent.getEvaluationConfig()?.enabled).toBe(true);
  });

  it("createAgent with evaluation: { enabled: true, model: 'haiku' } → evaluator uses haiku", async () => {
    const provider = new MockCompletionProvider()
      .enqueue(textCompletion(substantiveAnswer, usage))
      .enqueue(textCompletion(evalJson(), usage));

    const agent = createAgent({
      provider,
      evaluation: { enabled: true, model: 'haiku' },
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    await agent.run('What is the capital of France?');

    // Custom providers are not cloned; LLMEvaluator still passes evaluation.model
    expect(provider.completeCalls).toBe(2);
    expect(provider.lastCompleteParams?.model).toBe('haiku');
  });

  it('createAgent with invalid evaluation config → throws clear error', () => {
    const provider = new MockCompletionProvider();

    expect(() =>
      createAgent({
        provider,
        evaluation: {
          enabled: true,
          threshold: 2, // invalid: max is 1
        },
        telemetry: false,
        guardrails: false,
        memory: false,
      }),
    ).toThrow(/Invalid evaluation config/);
  });

  it('Zod defaults are applied (threshold: 0.8, maxRefinements: 2)', () => {
    const provider = new MockCompletionProvider();
    const agent = createAgent({
      provider,
      evaluation: { enabled: true },
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    const evalConfig = agent.getEvaluationConfig();
    expect(evalConfig?.threshold).toBe(0.8);
    expect(evalConfig?.maxRefinements).toBe(2);
    expect(evalConfig?.maxEvalTokens).toBe(512);
    expect(evalConfig?.skipIfNoTools).toBe(false);
  });

  it('createAgent with named provider + evaluation.model creates a secondary eval provider', () => {
    const agent = createAgent({
      provider: 'ollama',
      model: 'llama3.1',
      evaluation: { enabled: true, model: 'phi3' },
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    expect(agent.getEvaluator()).toBeInstanceOf(CompositeEvaluator);
    // Secondary provider is wired; main default model stays llama3.1
    expect(agent.getEvaluationConfig()?.model).toBe('phi3');
  });

  it('Agent constructor rejects invalid evaluation even without createAgent', () => {
    const provider = new MockCompletionProvider();

    expect(
      () =>
        new Agent({
          name: 'test',
          provider,
          evaluation: {
            enabled: true,
            maxRefinements: 99, // invalid: max is 5
          },
        }),
    ).toThrow(/Invalid evaluation config/);
  });
});
