/** Application-owned rate limit check. Adapters call this; they do not implement a limiter. */
export interface RateLimitHook {
  check(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

/** Client key for {@link RateLimitHook.check}. Prefers the first forwarded address. */
export function rateLimitClientKey(input: {
  forwardedFor?: string | string[];
  remoteAddress?: string;
  origin?: string;
}): string {
  const forwarded = Array.isArray(input.forwardedFor) ? input.forwardedFor[0] : input.forwardedFor;
  const first = forwarded?.split(',')[0]?.trim();
  if (first) {
    return first;
  }
  if (input.remoteAddress) {
    return input.remoteAddress;
  }
  if (input.origin) {
    return input.origin;
  }
  return 'anonymous';
}

/** `Retry-After` value in seconds, when the hook provided a delay. */
export function retryAfterHeader(retryAfterMs: number | undefined): string | undefined {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) {
    return undefined;
  }
  return String(Math.max(0, Math.ceil(retryAfterMs / 1000)));
}
