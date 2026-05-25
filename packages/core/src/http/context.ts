import type { RunContext } from '../context/run-context.js';

/** Header extractors for building {@link RunContext} from HTTP requests. */
export interface ContextExtractors {
  runId?: (headers: Record<string, string | undefined>) => string;
  orgId?: (headers: Record<string, string | undefined>) => string | undefined;
  userId?: (headers: Record<string, string | undefined>) => string | undefined;
}

/** Default header extractors for common tracing and tenancy headers. */
export const defaultExtractors: ContextExtractors = {
  runId: (headers) => headers['x-request-id'] || headers['x-trace-id'] || crypto.randomUUID(),
  orgId: (headers) => headers['x-org-id'],
  userId: (headers) => headers['x-user-id'],
};

/** Build a {@link RunContext} from HTTP headers for use with {@link runWith}. */
export function buildRunContext(
  headers: Record<string, string | undefined>,
  extractors?: Partial<ContextExtractors>,
): RunContext {
  const merged: ContextExtractors = { ...defaultExtractors, ...extractors };

  const runId = merged.runId?.(headers) ?? crypto.randomUUID();
  const requestId = headers['x-request-id'] ?? headers['x-trace-id'];
  const orgId = merged.orgId?.(headers);
  const userId = merged.userId?.(headers);

  return {
    runId,
    ...(requestId ? { requestId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
  };
}
