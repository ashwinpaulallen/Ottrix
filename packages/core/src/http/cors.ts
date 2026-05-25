/** Standard CORS headers for ottrix HTTP adapters. */
export function corsHeaders(origin?: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Request-Id, X-Org-Id, X-User-Id',
    'Access-Control-Max-Age': '86400',
  };
}
