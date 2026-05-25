import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { defer, Observable } from 'rxjs';
import { runWith } from 'ottrix';
import { buildRunContext } from 'ottrix/http';
import type { RunContextInterceptorOptions } from '../interfaces.js';
import { OTTRIX_RUN_CONTEXT_OPTIONS } from '../tokens.js';
import { readHeaders } from '../helpers/read-headers.js';

/** Establishes Ottrix {@link RunContext} for each HTTP request via ALS. */
@Injectable()
export class RunContextInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(OTTRIX_RUN_CONTEXT_OPTIONS)
    private readonly options?: RunContextInterceptorOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const extractors = this.options;
    const runContext = buildRunContext(readHeaders(request.headers ?? {}), extractors);

    return defer(
      () =>
        new Observable((subscriber) => {
          let subscription: { unsubscribe: () => void } | undefined;

          void runWith(runContext, () => {
            subscription = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (error) => subscriber.error(error),
              complete: () => subscriber.complete(),
            });
          });

          return () => subscription?.unsubscribe();
        }),
    );
  }
}
