import { describe, expect, it } from 'vitest';
import {
  ContentFilter,
  MaxLengthValidator,
  PiiDetector,
  SchemaValidator,
  detectPii,
  redactPii,
} from '../../src/guardrails/validators.js';
import { textCompletion } from '../fixtures/mock-provider.js';
import { GuardrailMiddleware } from '../../src/guardrails/middleware.js';

describe('PiiDetector', () => {
  it('detects email, phone, ssn, and credit card patterns', () => {
    expect(detectPii('Contact me at user@example.com')).toContain('email');
    expect(detectPii('Call (555) 123-4567 today')).toContain('phone');
    expect(detectPii('SSN 123-45-6789')).toContain('ssn');
    expect(detectPii('Card 4111-1111-1111-1111')).toContain('credit_card');
  });

  it('redacts PII in redact mode', () => {
    const input = 'Email user@example.com and SSN 123-45-6789';
    const redacted = redactPii(input);
    expect(redacted).not.toContain('user@example.com');
    expect(redacted).not.toContain('123-45-6789');
    expect(redacted).toContain('[REDACTED]');
  });

  it('flags PII in detect mode via middleware', async () => {
    const detector = new PiiDetector({ mode: 'detect' });
    const middleware = new GuardrailMiddleware([detector]);

    const post = await middleware.afterLlm({
      phase: 'llm',
      timing: 'post',
      agentName: 'test',
      messages: [],
      params: { messages: [] },
      result: textCompletion('Reach me at secret@corp.com', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    });

    expect(post.proceed).toBe(true);
    expect(post.flags.some((f) => f.includes('pii:email'))).toBe(true);
  });

  it('blocks when blockOnDetect is enabled', async () => {
    const detector = new PiiDetector({ mode: 'detect', blockOnDetect: true });
    const result = await detector.validate('my email is a@b.co');
    expect(result.passed).toBe(false);
  });
});

describe('ContentFilter', () => {
  it('blocks matching patterns', async () => {
    const filter = new ContentFilter({ patterns: ['forbidden'], action: 'block' });
    const result = await filter.validate('this is forbidden text');
    expect(result.passed).toBe(false);
  });
});

describe('SchemaValidator', () => {
  it('validates JSON output against schema', async () => {
    const validator = new SchemaValidator({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    });

    const ok = await validator.validate(JSON.stringify({ answer: '42' }));
    expect(ok.passed).toBe(true);

    const bad = await validator.validate(JSON.stringify({ wrong: true }));
    expect(bad.passed).toBe(false);
  });
});

describe('MaxLengthValidator', () => {
  it('rejects outputs over character limit', async () => {
    const validator = new MaxLengthValidator({ maxCharacters: 10 });
    const result = await validator.validate('this is way too long');
    expect(result.passed).toBe(false);
  });
});
