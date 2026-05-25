import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SseEvent } from 'ottrix/http';
import {
  createCircuitOpenError,
  createMockAgent,
  createMockProviderRegistry,
  createProviderError,
} from 'ottrix/testing';
import {
  ADAPTER_LABELS,
  createAllHarnesses,
  closeAllHarnesses,
  HEALTH_PATH,
  header,
  INJECTION_PROMPT,
  POST_PATH,
  STREAM_PATH,
  type AdapterId,
} from './adapter-harnesses.js';

interface HttpResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

interface SseResult {
  status: number;
  events: SseEvent[];
}

interface SummaryRow {
  scenario: string;
  statuses: Record<AdapterId, string>;
}

const summaryRows: SummaryRow[] = [];

function errorMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  return '';
}

function errorCode(body: unknown): string {
  if (body && typeof body === 'object' && 'code' in body) {
    return String((body as { code: unknown }).code);
  }
  return '';
}

function responseText(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'response' in body) {
    const value = (body as { response: unknown }).response;
    return value === undefined ? undefined : String(value);
  }
  return undefined;
}

function normalizePostSuccess(body: unknown): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }
  const record = body as Record<string, unknown>;
  return {
    keys: Object.keys(record).sort(),
    response: responseText(body),
    stopReason: (record.metadata as { stopReason?: string } | undefined)?.stopReason,
  };
}

function normalizeErrorBody(body: unknown): unknown {
  return {
    error: errorMessage(body),
    code: errorCode(body),
  };
}

function normalizeHealthBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }
  const record = body as {
    status?: unknown;
    providers?: Record<string, unknown>;
    uptime?: unknown;
    timestamp?: unknown;
  };
  return {
    keys: Object.keys(record).sort(),
    status: record.status,
    providerKeys: Object.keys(record.providers ?? {}).sort(),
  };
}

function normalizeCorsHeaders(headers: Record<string, string>): unknown {
  return {
    allowOrigin: header(headers, 'Access-Control-Allow-Origin'),
    allowMethods: header(headers, 'Access-Control-Allow-Methods'),
  };
}

function normalizeSseEvents(events: SseEvent[]): unknown {
  return events
    .filter(
      (event) =>
        event.event !== 'comment' &&
        event.event !== 'keepalive' &&
        !(event.event === 'message' && event.data.includes('keepalive')),
    )
    .map((event) => ({ event: event.event, data: event.data }));
}

function formatCell(status: number, ok: boolean): string {
  return `${status} ${ok ? '✓' : '✗'}`;
}

function recordSummary(scenario: string, statuses: Record<AdapterId, number>, ok: boolean): void {
  summaryRows.push({
    scenario,
    statuses: {
      express: formatCell(statuses.express, ok),
      fastify: formatCell(statuses.fastify, ok),
      hono: formatCell(statuses.hono, ok),
      nestjs: formatCell(statuses.nestjs, ok),
    },
  });
}

function assertParity<T>(
  scenario: string,
  results: Record<AdapterId, T>,
  pickStatus: (result: T) => number,
  normalize: (result: T) => unknown,
): void {
  const statuses = {
    express: pickStatus(results.express),
    fastify: pickStatus(results.fastify),
    hono: pickStatus(results.hono),
    nestjs: pickStatus(results.nestjs),
  };

  const baseline = normalize(results.express);
  const mismatches: string[] = [];

  for (const id of Object.keys(results) as AdapterId[]) {
    const normalized = normalize(results[id]);
    if (JSON.stringify(normalized) !== JSON.stringify(baseline)) {
      mismatches.push(
        `${ADAPTER_LABELS[id]}:\n  got:      ${JSON.stringify(normalized, null, 2)}\n  expected: ${JSON.stringify(baseline, null, 2)}`,
      );
    }
  }

  const statusMismatch = (Object.keys(statuses) as AdapterId[]).filter(
    (id) => statuses[id] !== statuses.express,
  );
  if (statusMismatch.length > 0) {
    mismatches.unshift(
      `Status codes differ (baseline Express=${statuses.express}): ${statusMismatch
        .map((id) => `${ADAPTER_LABELS[id]}=${statuses[id]}`)
        .join(', ')}`,
    );
  }

  const ok = mismatches.length === 0;
  recordSummary(scenario, statuses, ok);

  if (!ok) {
    throw new Error(`Adapter parity mismatch — ${scenario}\n\n${mismatches.join('\n\n')}`);
  }
}

async function withHarnesses<T>(
  options: Parameters<typeof createAllHarnesses>[0],
  run: (harnesses: Awaited<ReturnType<typeof createAllHarnesses>>) => Promise<T>,
): Promise<T> {
  const harnesses = await createAllHarnesses(options);
  try {
    return await run(harnesses);
  } finally {
    await closeAllHarnesses(harnesses);
  }
}

describe('adapter parity', () => {
  beforeAll(async () => {
    await import('reflect-metadata');
  });

  it('POST valid message → all return 200 with same response shape', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: 'hello' },
        });
      }

      assertParity(
        'POST valid',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizePostSuccess(result.body),
        }),
      );
    });
  });

  it('POST empty body → all return 400 with same error message', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH);
      }

      assertParity(
        'POST empty',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
        }),
      );
      expect(errorMessage(results.express.body)).toBe('Request body is empty');
    });
  });

  it("POST missing field → all return 400 with same error message", async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, { body: {} });
      }

      assertParity(
        'POST missing field',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
        }),
      );
      expect(errorMessage(results.express.body)).toBe("Missing 'message' field in request body");
    });
  });

  it('GET /stream → all produce same SSE event sequence', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, SseResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].requestSse(STREAM_PATH, { message: 'hello' });
      }

      assertParity(
        'SSE stream',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          events: normalizeSseEvents(result.events),
        }),
      );
    });
  });

  it('POST with injection → all return 403 with same error body', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: INJECTION_PROMPT },
        });
      }

      assertParity(
        'POST injection',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
        }),
      );
    });
  });

  it('GET /stream with injection → all return 403 with same error body', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, SseResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].requestSse(STREAM_PATH, { message: INJECTION_PROMPT });
      }

      assertParity(
        'GET stream injection',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          events: result.events,
        }),
      );
    });
  });

  it('POST ProviderError (rate_limit) → all return 429 + Retry-After', async () => {
    const agent = createMockAgent({ error: createProviderError('rate_limit') });
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: 'trigger error' },
        });
      }

      assertParity(
        'ProviderError',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
          retryAfter: header(result.headers, 'Retry-After'),
        }),
      );
    });
  });

  it('POST ProviderError (auth) → all return 502 + sanitized message', async () => {
    const agent = createMockAgent({ error: createProviderError('auth') });
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: 'trigger error' },
        });
      }

      assertParity(
        'ProviderError auth',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
        }),
      );
      expect(errorMessage(results.express.body)).toBe('Provider authentication failed');
    });
  });

  it('POST CircuitOpenError → all return 503', async () => {
    const agent = createMockAgent({ error: createCircuitOpenError(45_000) });
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: 'trigger error' },
        });
      }

      assertParity(
        'CircuitOpenError',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
          retryAfter: header(result.headers, 'Retry-After'),
        }),
      );
    });
  });

  it('POST generic Error → all return 500 + Internal server error', async () => {
    const agent = createMockAgent({ error: new Error('super secret stack trace details') });
    await withHarnesses({ agent, injection: 'block' }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('POST', POST_PATH, {
          body: { message: 'trigger error' },
        });
      }

      assertParity(
        'Generic Error',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeErrorBody(result.body),
        }),
      );
      expect(errorMessage(results.express.body)).toBe('Internal server error');
    });
  });

  it('GET /health → all return 200 with same shape', async () => {
    const agent = createMockAgent();
    const registry = createMockProviderRegistry({
      providers: { primary: 'healthy', backup: 'healthy' },
    });

    await withHarnesses({ agent, injection: 'block', healthCheck: true, registry }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('GET', HEALTH_PATH);
      }

      assertParity(
        'Health check',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          body: normalizeHealthBody(result.body),
        }),
      );
    });
  });

  it('OPTIONS → all return 204 with same CORS headers', async () => {
    const agent = createMockAgent();
    await withHarnesses({ agent, injection: 'block', cors: true }, async (harnesses) => {
      const results = {} as Record<AdapterId, HttpResult>;
      for (const id of Object.keys(harnesses) as AdapterId[]) {
        results[id] = await harnesses[id].request('OPTIONS', POST_PATH, {
          headers: { Origin: 'https://app.example.com' },
        });
      }

      assertParity(
        'CORS preflight',
        results,
        (result) => result.status,
        (result) => ({
          status: result.status,
          headers: normalizeCorsHeaders(result.headers),
        }),
      );
    });
  });
});

afterAll(() => {
  const headerLine = '  Scenario              Express  Fastify  Hono  NestJS';
  const divider = '  '.padEnd(headerLine.length, '-');
  const lines = [headerLine, divider];

  for (const row of summaryRows) {
    lines.push(
      `  ${row.scenario.padEnd(22)}${row.statuses.express.padEnd(9)}${row.statuses.fastify.padEnd(9)}${row.statuses.hono.padEnd(6)}${row.statuses.nestjs}`,
    );
  }

  console.log(`\n${lines.join('\n')}\n`);
});
