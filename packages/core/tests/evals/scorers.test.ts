import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ContainsScorer,
  ExactMatchScorer,
  JsonValidityScorer,
  parseGradeJson,
  RegexScorer,
  RelevanceScorer,
  SchemaMatchScorer,
  TokenUsageScorer,
} from '../../src/evals/scorers.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

describe('ExactMatchScorer', () => {
  it('returns 1 for an exact match and 0 for a mismatch', async () => {
    const scorer = new ExactMatchScorer();

    await expect(scorer.score('q', 'hello', 'hello')).resolves.toMatchObject({ score: 1 });
    await expect(scorer.score('q', 'hello', 'world')).resolves.toMatchObject({ score: 0 });
  });
});

describe('ContainsScorer', () => {
  it('returns the fraction of keywords found in the output', async () => {
    const scorer = new ContainsScorer(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    const result = await scorer.score('q', 'This mentions alpha, beta, and gamma only.');

    expect(result.score).toBeCloseTo(0.6);
    expect(result.metadata?.found).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('JsonValidityScorer', () => {
  it('returns 1 for valid JSON and 0 for invalid JSON', async () => {
    const scorer = new JsonValidityScorer();

    await expect(scorer.score('q', '{"ok":true}')).resolves.toMatchObject({ score: 1 });
    await expect(scorer.score('q', 'not json')).resolves.toMatchObject({ score: 0 });
  });
});

describe('SchemaMatchScorer', () => {
  it('validates output against a Zod schema', async () => {
    const scorer = new SchemaMatchScorer(
      z.object({
        answer: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    );

    await expect(
      scorer.score('q', '{"answer":"yes","confidence":0.9}'),
    ).resolves.toMatchObject({ score: 1 });

    await expect(
      scorer.score('q', '{"answer":"yes","confidence":2}'),
    ).resolves.toMatchObject({ score: 0 });
  });
});

describe('RelevanceScorer', () => {
  it('builds the grading prompt and parses the model JSON response', async () => {
    const provider = new MockCompletionProvider().enqueue(
      textCompletion('{"score":0.85,"reason":"Mostly relevant"}'),
    );
    const scorer = new RelevanceScorer(provider);

    const result = await scorer.score('What is RLHF?', 'RLHF aligns models with human preferences.');

    expect(provider.completeCalls).toBe(1);
    const prompt = provider.lastCompleteParams?.messages[0]?.content;
    const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    expect(promptText).toContain('What is RLHF?');
    expect(promptText).toContain('RLHF aligns models with human preferences.');
    expect(result.score).toBeCloseTo(0.85);
    expect(result.reason).toBe('Mostly relevant');
  });
});

describe('RegexScorer', () => {
  it('is stable across repeated calls with global regex patterns', async () => {
    const scorer = new RegexScorer(/yes/g);
    await expect(scorer.score('', 'yes')).resolves.toMatchObject({ score: 1 });
    await expect(scorer.score('', 'yes')).resolves.toMatchObject({ score: 1 });
  });
});

describe('TokenUsageScorer', () => {
  it('treats maxTotalTokens=0 as a strict zero-token budget', async () => {
    const scorer = new TokenUsageScorer(0);
    const result = await scorer.score('', '', undefined, {
      tokenUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    });
    expect(result.score).toBe(0);
  });
});

describe('ContainsScorer edge cases', () => {
  it('ignores empty keywords and returns 0 when none remain', async () => {
    const scorer = new ContainsScorer(['', 'alpha']);
    const result = await scorer.score('q', 'alpha only');
    expect(result.score).toBe(1);
  });

  it('returns 0 when no keywords are configured', async () => {
    const scorer = new ContainsScorer([]);
    await expect(scorer.score('q', 'anything')).resolves.toMatchObject({ score: 0 });
  });
});

describe('parseGradeJson', () => {
  it('parses fenced JSON from grader output', () => {
    const result = parseGradeJson('Here is the grade:\n```json\n{"score":0.7,"reason":"Good"}\n```');
    expect(result.score).toBeCloseTo(0.7);
    expect(result.reason).toBe('Good');
  });
});

describe('JsonValidityScorer markdown fences', () => {
  it('accepts JSON wrapped in markdown fences', async () => {
    const scorer = new JsonValidityScorer();
    await expect(scorer.score('q', '```json\n{"ok":true}\n```')).resolves.toMatchObject({ score: 1 });
  });
});
