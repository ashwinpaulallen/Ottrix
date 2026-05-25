import { describe, expect, it } from 'vitest';
import { createMockAgent } from 'ottrix/testing';
import { createStreamHandler } from '../src/handlers.js';
import { invokeSseHandler } from './helpers.js';

describe('createStreamHandler', () => {
  it('valid GET with message param → 200, SSE headers', async () => {
    const stream = createStreamHandler({ agent: createMockAgent(), injection: false });
    const result = await invokeSseHandler(stream, '/stream', { message: 'hello' });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('events arrive in correct SSE format', async () => {
    const stream = createStreamHandler({ agent: createMockAgent(), injection: false });
    const result = await invokeSseHandler(stream, '/stream', { message: 'hello' });
    const types = result.events.map((event) => event.event);

    expect(types.filter((type) => type === 'text').length).toBeGreaterThan(0);
    expect(types.at(-1)).toBe('done');
  });

  it('empty message → 400', async () => {
    const stream = createStreamHandler({ agent: createMockAgent(), injection: false });
    const result = await invokeSseHandler(stream, '/stream', { message: '' });

    expect(result.status).toBe(400);
    expect(result.events).toHaveLength(0);
  });

  it('agent error during stream → error event sent', async () => {
    const stream = createStreamHandler({
      agent: createMockAgent({ error: new Error('stream failed') }),
      injection: false,
    });
    const result = await invokeSseHandler(stream, '/stream', { message: 'hello' });

    expect(result.status).toBe(200);
    expect(result.events.some((event) => event.event === 'error')).toBe(true);
  });
});
