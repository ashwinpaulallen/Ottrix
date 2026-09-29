import { describe, expect, it } from 'vitest';
import {
  buildOutcomeSummaryText,
  buildProseDigestPrompt,
  buildTopicIndexPrompt,
} from '../../../src/agent/context/compaction-prompts.js';

const messages = [
  { role: 'user', content: 'Ship the billing fix before Friday.' },
  { role: 'assistant', content: 'Invoice retry is the open decision.' },
];

describe('buildTopicIndexPrompt', () => {
  it('contains the message content', () => {
    const prompt = buildTopicIndexPrompt(messages, { maxTokens: 400 });

    expect(prompt).toContain('[user]: Ship the billing fix before Friday.');
    expect(prompt).toContain('[assistant]: Invoice retry is the open decision.');
    expect(prompt).toContain('<messages_to_index>');
    expect(prompt).toContain('</messages_to_index>');
  });

  it('contains maxTokens in the prompt', () => {
    const prompt = buildTopicIndexPrompt(messages, { maxTokens: 320 });

    expect(prompt).toContain('Maximum length: 320 tokens.');
  });

  it('instructs the model to return only the bullet list', () => {
    const prompt = buildTopicIndexPrompt(messages, { maxTokens: 400 });

    expect(prompt).toContain('Return ONLY the bullet list. No introduction, no preamble, no explanation.');
    expect(prompt.startsWith('You are compacting a conversation for a long-running agent.')).toBe(true);
  });
});

describe('buildProseDigestPrompt', () => {
  it('includes the topic index section when provided', () => {
    const prompt = buildProseDigestPrompt(messages, '- billing retry stays open', { maxTokens: 600 });

    expect(prompt).toContain('<topic_index>');
    expect(prompt).toContain('- billing retry stays open');
    expect(prompt).toContain('</topic_index>');
    expect(prompt).toContain('[user]: Ship the billing fix before Friday.');
  });

  it('omits the topic index section when undefined', () => {
    const prompt = buildProseDigestPrompt(messages, undefined, { maxTokens: 600 });

    expect(prompt).not.toContain('<topic_index>');
    expect(prompt).not.toContain('</topic_index>');
    expect(prompt).toContain('<messages_to_digest>');
  });
});

describe('buildOutcomeSummaryText', () => {
  it('truncates the result preview at 200 characters', () => {
    const preview = 'x'.repeat(250);
    const summary = buildOutcomeSummaryText('search_docs', preview);

    expect(summary).toBe(`[Tool 'search_docs' completed — result: ${'x'.repeat(200)}...]`);
    expect(summary).not.toContain('x'.repeat(201));
  });

  it('keeps a short result preview intact', () => {
    expect(buildOutcomeSummaryText('search_docs', 'found 2 matches')).toBe(
      "[Tool 'search_docs' completed — result: found 2 matches]",
    );
  });
});

describe('compaction prompts', () => {
  it('returns strings synchronously', () => {
    const topic = buildTopicIndexPrompt(messages, { maxTokens: 400 });
    const digest = buildProseDigestPrompt(messages, undefined, { maxTokens: 600 });
    const outcome = buildOutcomeSummaryText('search_docs', 'ok');

    expect(typeof topic).toBe('string');
    expect(typeof digest).toBe('string');
    expect(typeof outcome).toBe('string');
    expect(topic).not.toBeInstanceOf(Promise);
    expect(digest).not.toBeInstanceOf(Promise);
    expect(outcome).not.toBeInstanceOf(Promise);
  });
});
