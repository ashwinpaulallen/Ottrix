import { describe, expect, it } from 'vitest';

import { extractMessage } from '../../src/http/body.js';

describe('extractMessage', () => {
  it('extracts a trimmed message from a valid body', () => {
    expect(extractMessage({ message: '  hello world  ' })).toEqual({
      ok: true,
      message: 'hello world',
    });
  });

  it('rejects empty body', () => {
    expect(extractMessage(undefined)).toEqual({
      ok: false,
      error: 'Request body is empty',
      status: 400,
    });
  });

  it('rejects non-object body', () => {
    expect(extractMessage('hello')).toEqual({
      ok: false,
      error: 'Request body must be JSON',
      status: 400,
    });
  });

  it('rejects missing field', () => {
    expect(extractMessage({})).toEqual({
      ok: false,
      error: "Missing 'message' field in request body",
      status: 400,
    });
  });

  it('rejects wrong field type', () => {
    expect(extractMessage({ message: 42 })).toEqual({
      ok: false,
      error: "Field 'message' must be a string",
      status: 400,
    });
  });

  it('rejects empty string', () => {
    expect(extractMessage({ message: '   ' })).toEqual({
      ok: false,
      error: "Field 'message' must not be empty",
      status: 400,
    });
  });

  it('supports a custom field name', () => {
    expect(extractMessage({ prompt: 'run this' }, 'prompt')).toEqual({
      ok: true,
      message: 'run this',
    });
    expect(extractMessage({ prompt: 1 }, 'prompt')).toEqual({
      ok: false,
      error: "Field 'prompt' must be a string",
      status: 400,
    });
  });
});
