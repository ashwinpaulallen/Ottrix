import { ConfigurationError } from '../tools/errors.js';

/** CORS policy for browser clients. */
export interface CorsConfig {
  /** Exact origin allowlist, a predicate, or `'*'` for anonymous wildcard access. */
  origins: string[] | ((origin: string) => boolean) | '*';
  /** Allow cookies and credentialed auth headers. @defaultValue false */
  credentials?: boolean;
  /** @defaultValue ['GET', 'POST', 'OPTIONS'] */
  allowedMethods?: string[];
  /** @defaultValue Content-Type, Authorization, and the ottrix context headers */
  allowedHeaders?: string[];
  /** Preflight cache lifetime in seconds. @defaultValue 86400 */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'OPTIONS'];
const DEFAULT_HEADERS = ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Org-Id', 'X-User-Id'];

/**
 * Build CORS headers for one request.
 *
 * Returns `null` when the origin is not allowed. Wildcard origins cannot be
 * combined with credentials.
 */
export function buildCorsHeaders(
  requestOrigin: string | undefined,
  config: CorsConfig,
): Record<string, string> | null {
  if (config.origins === '*') {
    if (config.credentials) {
      throw new ConfigurationError(
        "CORS: cannot use wildcard origin '*' with credentials: true. " +
          'Specify exact origins instead.',
      );
    }
    return buildHeaders('*', config);
  }

  if (!requestOrigin) {
    return null;
  }

  const allowed =
    typeof config.origins === 'function'
      ? config.origins(requestOrigin)
      : config.origins.includes(requestOrigin);

  if (!allowed) {
    return null;
  }

  return buildHeaders(requestOrigin, config);
}

/**
 * Resolve adapter CORS options.
 * `true` keeps the legacy wildcard helper. A {@link CorsConfig} uses {@link buildCorsHeaders}.
 */
export function requestCorsHeaders(
  requestOrigin: string | undefined,
  cors: true | CorsConfig,
): Record<string, string> | null {
  if (cors === true) {
    return corsHeaders(requestOrigin);
  }
  return buildCorsHeaders(requestOrigin, cors);
}

/** Reject invalid CORS policies when an adapter is constructed. */
export function validateCorsConfig(config: CorsConfig): void {
  if (config.origins === '*') {
    buildCorsHeaders(undefined, config);
  }
}

function buildHeaders(origin: string, config: CorsConfig): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    ...(config.credentials ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'Access-Control-Allow-Methods': (config.allowedMethods ?? DEFAULT_METHODS).join(', '),
    'Access-Control-Allow-Headers': (config.allowedHeaders ?? DEFAULT_HEADERS).join(', '),
    'Access-Control-Max-Age': String(config.maxAge ?? 86400),
    ...(origin !== '*' ? { Vary: 'Origin' } : {}),
  };
}

/** @deprecated Use {@link buildCorsHeaders} with an explicit {@link CorsConfig} instead. */
export function corsHeaders(origin?: string): Record<string, string> {
  return buildHeaders(origin ?? '*', { origins: '*' });
}
