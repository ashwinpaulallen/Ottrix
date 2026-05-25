import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { defer, finalize, Observable } from 'rxjs';
import { getTelemetry } from 'ottrix';

/** Wraps each HTTP request in an Ottrix telemetry span. */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      path?: string;
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode?: number }>();

    const telemetry = getTelemetry();
    const startedAt = Date.now();
    const span = telemetry.startSpan('http.request', {
      'http.method': request.method ?? 'UNKNOWN',
      'http.route': request.url ?? request.path ?? '/',
    });

    return defer(
      () =>
        new Observable((subscriber) => {
          const subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error) => {
              span.setStatus('error', error instanceof Error ? error.message : String(error));
              subscriber.error(error);
            },
            complete: () => {
              span.setStatus('ok');
              subscriber.complete();
            },
          });

          return () => subscription.unsubscribe();
        }),
    ).pipe(
      finalize(() => {
        span.setAttribute('http.status_code', response.statusCode ?? 200);
        span.setAttribute('http.duration_ms', Date.now() - startedAt);
        span.end();
      }),
    );
  }
}
