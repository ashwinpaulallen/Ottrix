import { describe, expect, it } from 'vitest';
import { createMockAgent } from 'ottrix/testing';
import { createAgentHandlers } from '../src/handlers.js';
import { invokeHandler, invokeSseHandler } from './helpers.js';

describe('createAgentHandlers', () => {
  const agent = createMockAgent();
  const handlers = createAgentHandlers({ agent, injection: false, cors: true });

  it('returns POST, GET, and OPTIONS handlers', () => {
    expect(typeof handlers.POST).toBe('function');
    expect(typeof handlers.GET).toBe('function');
    expect(typeof handlers.OPTIONS).toBe('function');
  });

  it('POST works', async () => {
    const result = await invokeHandler(handlers.POST, 'POST', '/chat', {
      body: { message: 'hello' },
    });
    expect(result.status).toBe(200);
  });

  it('GET streaming works', async () => {
    const result = await invokeSseHandler(handlers.GET, '/chat', { message: 'hello' });
    expect(result.status).toBe(200);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    const result = await invokeHandler(handlers.OPTIONS, 'OPTIONS', '/chat', {
      headers: { Origin: 'https://app.example.com' },
    });

    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-origin']).toBeDefined();
  });
});
