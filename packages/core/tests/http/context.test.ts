import { describe, expect, it, vi } from 'vitest';

import { buildRunContext, defaultExtractors } from '../../src/http/context.js';

describe('buildRunContext', () => {
  it('uses x-request-id as runId by default', () => {
    const ctx = buildRunContext({ 'x-request-id': 'req-123' });

    expect(ctx.runId).toBe('req-123');
    expect(ctx.requestId).toBe('req-123');
  });

  it('falls back to x-trace-id when x-request-id is missing', () => {
    const ctx = buildRunContext({ 'x-trace-id': 'trace-456' });

    expect(ctx.runId).toBe('trace-456');
    expect(ctx.requestId).toBe('trace-456');
  });

  it('generates a UUID when tracing headers are missing', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');

    const ctx = buildRunContext({});

    expect(ctx.runId).toBe('00000000-0000-4000-8000-000000000001');
    vi.restoreAllMocks();
  });

  it('extracts org and user headers', () => {
    const ctx = buildRunContext({
      'x-request-id': 'req-1',
      'x-org-id': 'org-a',
      'x-user-id': 'user-b',
    });

    expect(ctx.orgId).toBe('org-a');
    expect(ctx.userId).toBe('user-b');
  });

  it('allows custom extractors to override defaults', () => {
    const ctx = buildRunContext(
      { 'x-request-id': 'ignored' },
      {
        runId: () => 'custom-run',
        orgId: () => 'custom-org',
        userId: () => 'custom-user',
      },
    );

    expect(ctx.runId).toBe('custom-run');
    expect(ctx.orgId).toBe('custom-org');
    expect(ctx.userId).toBe('custom-user');
  });

  it('exposes default extractors', () => {
    expect(defaultExtractors.runId?.({ 'x-request-id': 'abc' })).toBe('abc');
    expect(defaultExtractors.orgId?.({ 'x-org-id': 'org' })).toBe('org');
  });
});
