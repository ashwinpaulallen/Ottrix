import { describe, expect, it, vi } from 'vitest';

import { buildCorsHeaders, corsHeaders } from '../../src/http/cors.js';
import { ConfigurationError } from '../../src/tools/errors.js';

const allowlist = ['https://app.example.com'];

describe('buildCorsHeaders', () => {
  it('returns wildcard headers when origins is * and credentials are off', () => {
    expect(buildCorsHeaders('https://app.example.com', { origins: '*' })).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Request-Id, X-Org-Id, X-User-Id',
      'Access-Control-Max-Age': '86400',
    });
  });

  it('throws ConfigurationError when wildcard origins are combined with credentials', () => {
    expect(() => buildCorsHeaders('https://app.example.com', { origins: '*', credentials: true })).toThrow(
      ConfigurationError,
    );
    expect(() => buildCorsHeaders(undefined, { origins: '*', credentials: true })).toThrow(
      /cannot use wildcard origin/,
    );
  });

  it('echoes an allowlisted origin and sets Vary', () => {
    const headers = buildCorsHeaders('https://app.example.com', { origins: allowlist });

    expect(headers).toMatchObject({
      'Access-Control-Allow-Origin': 'https://app.example.com',
      Vary: 'Origin',
    });
  });

  it('returns null when the origin is not allowlisted', () => {
    expect(buildCorsHeaders('https://evil.example', { origins: allowlist })).toBeNull();
    expect(buildCorsHeaders(undefined, { origins: allowlist })).toBeNull();
  });

  it('uses a predicate to decide whether an origin is allowed', () => {
    const origins = vi.fn((origin: string) => origin.endsWith('.example.com'));

    const allowed = buildCorsHeaders('https://app.example.com', { origins });
    const denied = buildCorsHeaders('https://other.test', { origins });

    expect(origins).toHaveBeenCalledWith('https://app.example.com');
    expect(origins).toHaveBeenCalledWith('https://other.test');
    expect(allowed?.['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(denied).toBeNull();
  });

  it('sets Access-Control-Allow-Credentials when credentials are enabled', () => {
    const headers = buildCorsHeaders('https://app.example.com', {
      origins: allowlist,
      credentials: true,
    });

    expect(headers?.['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers?.['Access-Control-Allow-Origin']).toBe('https://app.example.com');
  });
});

describe('corsHeaders', () => {
  it('still returns wildcard headers', () => {
    expect(corsHeaders()).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Request-Id, X-Org-Id, X-User-Id',
      'Access-Control-Max-Age': '86400',
    });
  });
});
