import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { defer, from, lastValueFrom } from 'rxjs';
import { runWith, type RunContext } from 'ottrix';
import type { RunContextInterceptorOptions } from '../interfaces.js';
import { OTTRIX_RUN_CONTEXT_OPTIONS } from '../tokens.js';

/** Establishes Ottrix {@link RunContext} for each HTTP request via ALS. */
@Injectable()
export class RunContextInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(OTTRIX_RUN_CONTEXT_OPTIONS)
    private readonly options?: RunContextInterceptorOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();

    const runContext = buildRunContext(request, this.options);

    return defer(() => from(runWith(runContext, () => lastValueFrom(next.handle()))));
  }
}

function buildRunContext(
  request: { headers?: Record<string, string | string[] | undefined> },
  options?: RunContextInterceptorOptions,
): RunContext {
  const headers = request.headers ?? {};
  const runId = readHeader(headers, 'x-request-id') ?? randomUUID();
  const ctx: RunContext = { runId };

  const orgId = options?.orgId?.(request as Record<string, unknown>) ??
    readHeader(headers, 'x-org-id');
  if (orgId) {
    (ctx as RunContext & { orgId: string }).orgId = orgId;
  }

  const userId = options?.userId?.(request as Record<string, unknown>) ??
    readHeader(headers, 'x-user-id');
  if (userId) {
    (ctx as RunContext & { userId: string }).userId = userId;
  }

  return ctx;
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
