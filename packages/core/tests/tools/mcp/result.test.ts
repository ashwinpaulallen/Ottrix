import { describe, expect, it } from 'vitest';
import {
  MCPToolError,
  extractTextContent,
  normalizeToolCallResult,
} from '../../../src/tools/mcp/json-rpc.js';

describe('normalizeToolCallResult', () => {
  it('returns the structured result unchanged on success', () => {
    const result = normalizeToolCallResult({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
  });

  it('preserves multi-block content (no lossy extraction)', () => {
    const result = normalizeToolCallResult({
      content: [
        { type: 'text', text: 'part one' },
        { type: 'image', data: 'base64...' },
      ],
    });

    expect(result.content).toHaveLength(2);
    expect(result.content?.[1]?.type).toBe('image');
  });

  it('wraps primitive results in a synthetic text block', () => {
    const result = normalizeToolCallResult(42);
    expect(result.content).toEqual([{ type: 'text', text: '42' }]);
  });

  it('throws MCPToolError when isError is true', () => {
    expect(() =>
      normalizeToolCallResult({
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      }),
    ).toThrow(MCPToolError);
  });

  it('MCPToolError carries the full result and content', () => {
    try {
      normalizeToolCallResult({
        content: [
          { type: 'text', text: 'broken' },
          { type: 'text', text: 'context' },
        ],
        isError: true,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MCPToolError);
      const toolError = error as MCPToolError;
      expect(toolError.message).toBe('broken\ncontext');
      expect(toolError.content).toHaveLength(2);
      expect(toolError.result.isError).toBe(true);
    }
  });
});

describe('extractTextContent', () => {
  it('joins all text blocks with newlines', () => {
    expect(
      extractTextContent({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\ntwo');
  });

  it('returns undefined when no text blocks exist', () => {
    expect(extractTextContent({ content: [{ type: 'image', data: 'x' }] })).toBeUndefined();
    expect(extractTextContent({})).toBeUndefined();
  });
});
