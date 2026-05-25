import { describe, expect, it } from 'vitest';

import { corsHeaders } from '../../src/http/cors.js';

describe('corsHeaders', () => {
  it('returns wildcard origin by default', () => {
    expect(corsHeaders()).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Request-Id, X-Org-Id, X-User-Id',
      'Access-Control-Max-Age': '86400',
    });
  });

  it('uses the provided origin when set', () => {
    expect(corsHeaders('https://app.example.com')['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    );
  });
});
