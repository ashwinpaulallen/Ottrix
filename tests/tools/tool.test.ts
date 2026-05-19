import { describe, expect, it, vi } from 'vitest';
import {
  BaseTool,
  ToolValidationError,
  extractErrorDetails,
  type ToolExecutionEvents,
} from '../../src/tools/tool.js';

class FailingTool extends BaseTool {
  constructor(private readonly toThrow: Error) {
    super({
      name: 'failing',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
    });
  }

  protected _execute(): Promise<unknown> {
    return Promise.reject(this.toThrow);
  }
}

class CodedError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    this.data = data;
  }
}

class SlowTool extends BaseTool {
  constructor(timeoutMs?: number) {
    super({
      name: 'slow',
      description: 'slow tool',
      inputSchema: { type: 'object', properties: {} },
      timeoutMs,
    });
  }

  protected _execute(): Promise<unknown> {
    return new Promise((resolve) => setTimeout(() => resolve('done'), 200));
  }
}

class EchoTool extends BaseTool {
  private executeCount = 0;

  constructor(events?: ToolExecutionEvents) {
    super({
      name: 'echo',
      description: 'echoes message',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      events,
    });
  }

  protected _execute(input: Record<string, unknown>): Promise<unknown> {
    this.executeCount += 1;
    return Promise.resolve({ echo: input.message });
  }

  getExecuteCount(): number {
    return this.executeCount;
  }
}

describe('BaseTool.execute', () => {
  it('validates input and returns success result', async () => {
    const tool = new EchoTool();
    const result = await tool.execute({ message: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echo: 'hello' });
  });

  it('returns validation error without calling _execute', async () => {
    const tool = new EchoTool();
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('message');
    expect(tool.getExecuteCount()).toBe(0);
  });

  it('times out long-running tools', async () => {
    const tool = new SlowTool(50);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('emits onStart, onComplete, and onError events', async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    const ok = new EchoTool({ onStart, onComplete, onError });
    await ok.execute({ message: 'hi' });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();

    const bad = new EchoTool({ onStart, onComplete, onError });
    await bad.execute({});
    expect(onError).toHaveBeenCalledOnce();
    const errorEvent = onError.mock.calls[0]?.[0] as {
      stage: string;
      error: Error;
    };
    expect(errorEvent.stage).toBe('validation');
    expect(errorEvent.error).toBeInstanceOf(ToolValidationError);
  });

  it('populates errorDetails for validation failures', async () => {
    const tool = new EchoTool();
    const result = await tool.execute({});
    expect(result.errorDetails?.name).toBe('ToolValidationError');
    const validationData = result.errorDetails?.data as { errors: string[] };
    expect(validationData.errors.length).toBeGreaterThan(0);
  });

  it('surfaces error code and data on errorDetails for thrown errors', async () => {
    const tool = new FailingTool(new CodedError('rate limited', 429, { retryAfterMs: 1000 }));
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.errorDetails).toEqual({
      name: 'CodedError',
      code: 429,
      data: { retryAfterMs: 1000 },
    });
  });

  it('errorDetails has just a name for plain errors', async () => {
    const tool = new FailingTool(new Error('boom'));
    const result = await tool.execute({});
    expect(result.errorDetails).toEqual({ name: 'Error' });
  });
});

describe('extractErrorDetails', () => {
  it('reads numeric code and data from errors', () => {
    const details = extractErrorDetails(new CodedError('x', 7, { y: 1 }));
    expect(details).toEqual({ name: 'CodedError', code: 7, data: { y: 1 } });
  });

  it('ignores non-numeric codes', () => {
    const err = new Error('x') as Error & { code?: unknown };
    err.code = 'ENOENT';
    const details = extractErrorDetails(err);
    expect(details.code).toBeUndefined();
    expect(details.name).toBe('Error');
  });

  it('handles non-Error values', () => {
    expect(extractErrorDetails('boom')).toEqual({ name: 'string' });
    expect(extractErrorDetails(42)).toEqual({ name: 'number' });
  });
});
