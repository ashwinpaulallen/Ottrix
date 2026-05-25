import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StructuredOutputError } from '../../src/agent/structured-output.js';
import { checkHealth } from '../../src/http/health.js';
import { CircuitOpenError } from '../../src/providers/circuit-breaker.js';
import {
  createCircuitOpenError,
  createMockAgent,
  createMockProviderRegistry,
  createProviderError,
} from '../../src/testing/mocks.js';

describe('createMockAgent', () => {
  it('run() returns the expected default response', async () => {
    const agent = createMockAgent();
    const result = await agent.run('hello');

    expect(result.response).toBe('Hello world');
    expect(result.metadata.stopReason).toBe('completed');
  });

  it('run() throws when configured with an error', async () => {
    const error = new Error('boom');
    const agent = createMockAgent({ error });

    await expect(agent.run('hello')).rejects.toThrow('boom');
  });

  it('stream() yields the expected default events', async () => {
    const agent = createMockAgent();
    const events = [];

    for await (const event of agent.stream('hello')) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text', 'text', 'done']);
  });

  it('stream() throws when configured with an error', async () => {
    const agent = createMockAgent({ error: new Error('stream failed') });

    await expect(async () => {
      for await (const _event of agent.stream('hello')) {
        // drain
      }
    }).rejects.toThrow('stream failed');
  });

  it('captures RunContext during run()', async () => {
    const agent = createMockAgent();
    await agent.run('hello');

    expect(agent.getLastRunContext()).toBeUndefined();
  });
});

describe('createProviderError', () => {
  it('creates typed provider errors', () => {
    const error = createProviderError('rate_limit');
    expect(error.code).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });

  it('creates circuit open errors via helper', () => {
    const error = createCircuitOpenError(12_000);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error.retryAfterMs).toBe(12_000);
  });

  it('creates structured output errors for contract mapping tests', () => {
    const error = new StructuredOutputError('bad json', '{}', new z.ZodError([]), 1);
    expect(error.name).toBe('StructuredOutputError');
  });
});

describe('createMockProviderRegistry', () => {
  it('reports healthy providers', async () => {
    const registry = createMockProviderRegistry({
      providers: { primary: 'healthy', backup: 'healthy' },
    });

    const health = await checkHealth(registry);

    expect(health.status).toBe('healthy');
    expect(health.providers.primary?.status).toBe('up');
    expect(health.providers.backup?.status).toBe('up');
  });

  it('reports degraded providers', async () => {
    const registry = createMockProviderRegistry({
      providers: { primary: 'healthy', backup: 'down' },
    });

    const health = await checkHealth(registry);

    expect(health.status).toBe('degraded');
    expect(health.providers.backup?.status).toBe('down');
  });

  it('reports circuit_open providers', async () => {
    const registry = createMockProviderRegistry({
      providers: { primary: 'circuit_open' },
    });

    const health = await checkHealth(registry);

    expect(health.providers.primary?.status).toBe('circuit_open');
    expect(health.status).toBe('unhealthy');
  });
});
