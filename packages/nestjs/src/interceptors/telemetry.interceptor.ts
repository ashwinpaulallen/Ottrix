import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { defer, from, lastValueFrom } from 'rxjs';
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

    return defer(() =>
      from(
        (async () => {
          try {
            const result = await lastValueFrom(next.handle());
            span.setStatus('ok');
            return result;
          } catch (error) {
            span.setStatus('error', error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            span.setAttribute('http.status_code', response.statusCode ?? 200);
            span.setAttribute('http.duration_ms', Date.now() - startedAt);
            span.end();
          }
        })(),
      ),
    );
  }
}
