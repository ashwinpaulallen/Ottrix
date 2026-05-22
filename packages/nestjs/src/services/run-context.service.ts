import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { getRunContext, runWith, type RunContext } from 'ottrix';
import type { OttrixModuleOptions } from '../interfaces.js';
import { OTTRIX_MODULE_OPTIONS } from '../tokens.js';

/** NestJS helper for Ottrix {@link RunContext} (AsyncLocalStorage). */
@Injectable()
export class RunContextService {
  private readonly enabled: boolean;

  constructor(@Inject(OTTRIX_MODULE_OPTIONS) options: OttrixModuleOptions) {
    this.enabled = options.runContext !== false;
  }

  /** Whether RunContext integration is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Returns the active {@link RunContext}, if any. */
  getContext(): RunContext | undefined {
    return getRunContext();
  }

  /** Run `fn` inside the given {@link RunContext}. */
  runWith<T>(ctx: RunContext, fn: () => Promise<T> | T): Promise<T> {
    if (!this.enabled) {
      return Promise.resolve(fn());
    }
    return runWith(ctx, fn);
  }

  /** Build a {@link RunContext} from common HTTP headers. */
  contextFromRequest(request: {
    headers?: Record<string, string | string[] | undefined>;
    user?: { orgId?: string; id?: string };
  }): RunContext {
    const headers = request.headers ?? {};
    const runId = readHeader(headers, 'x-run-id') ?? randomUUID();
    const requestId = readHeader(headers, 'x-request-id');
    const orgId = request.user?.orgId ?? readHeader(headers, 'x-org-id');

    const ctx: RunContext = { runId };
    if (requestId) {
      ctx.requestId = requestId;
    }
    if (orgId) {
      (ctx as RunContext & { orgId: string }).orgId = orgId;
    }
    return ctx;
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
