import { describe, expect, it } from 'vitest';
import { createMockAgent, createMockProviderRegistry } from 'ottrix/testing';
import { createHealthHandler } from '../src/handlers.js';
import { invokeHandler } from './helpers.js';

describe('createHealthHandler', () => {
  it('no registry → simple 200 ok', async () => {
    const health = createHealthHandler();
    const result = await invokeHandler(health, 'GET', '/health');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'ok' });
  });

  it('healthy registry → 200 with provider details', async () => {
    const health = createHealthHandler({
      registry: createMockProviderRegistry({
        providers: { primary: 'healthy', backup: 'healthy' },
      }),
    });
    const result = await invokeHandler(health, 'GET', '/health');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: expect.any(String),
      providers: expect.any(Object),
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  it('unhealthy registry → 503', async () => {
    const health = createHealthHandler({
      registry: createMockProviderRegistry({
        providers: { primary: 'down' },
      }),
    });
    const result = await invokeHandler(health, 'GET', '/health');

    expect(result.status).toBe(503);
  });
});
