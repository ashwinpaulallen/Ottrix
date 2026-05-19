import { describe, expect, it } from 'vitest';
import {
  extractStructuredJsonText,
  parseAndValidateStructuredOutput,
  resolveStructuredOutputMaxAttempts,
} from './structured-output.js';
import { z } from 'zod';

describe('structured-output helpers', () => {
  it('resolves max attempts as 1 + retry count', () => {
    expect(resolveStructuredOutputMaxAttempts(3)).toBe(4);
    expect(resolveStructuredOutputMaxAttempts(0)).toBe(1);
    expect(resolveStructuredOutputMaxAttempts(undefined)).toBe(4);
  });

  it('extracts JSON from embedded markdown fences', () => {
    const inner = '{"ok":true}';
    const text = `Here is the result:\n\`\`\`json\n${inner}\n\`\`\`\nThanks!`;
    expect(extractStructuredJsonText(text)).toBe(inner);
  });

  it('extracts JSON object surrounded by prose', () => {
    const payload = { name: 'Ada', age: 36 };
    const text = `Sure! ${JSON.stringify(payload)} — hope that helps.`;
    expect(extractStructuredJsonText(text)).toBe(JSON.stringify(payload));
  });

  it('validates extracted JSON against schema', () => {
    const schema = z.object({ id: z.number() });
    const result = parseAndValidateStructuredOutput('Answer: {"id": 1}', schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: 1 });
    }
  });
});
