import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { defer, from, lastValueFrom } from 'rxjs';
import { TelemetryService } from '../services/telemetry.service.js';
import { RunContextService } from '../services/run-context.service.js';

/** Wraps each HTTP request in an Ottrix telemetry span. */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly runContextService: RunContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      user?: { orgId?: string; id?: string };
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode?: number }>();

    const telemetry = this.telemetryService.getTelemetry();
    const runContext = this.runContextService.contextFromRequest(request);

    const span = telemetry.startSpan('http.request', {
      'http.method': request.method ?? 'UNKNOWN',
      'http.route': request.url ?? '/',
      'ottrix.run.id': runContext.runId,
      ...(runContext.requestId ? { 'ottrix.request.id': runContext.requestId } : {}),
      ...(runContext.agentName ? { 'ottrix.agent.name': runContext.agentName } : {}),
      ...readOrgAttribute(runContext),
    });

    return defer(() =>
      from(
        this.runContextService.runWith(runContext, async () => {
          try {
            const result: unknown = await lastValueFrom(next.handle());
            span.setStatus('ok');
            return result;
          } catch (error) {
            span.setStatus('error', error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            span.setAttribute('http.status_code', response.statusCode ?? 200);
            span.end();
          }
        }),
      ),
    );
  }
}

function readOrgAttribute(runContext: Record<string, unknown>): Record<string, string> {
  if (typeof runContext.orgId === 'string') {
    return { 'ottrix.org.id': runContext.orgId };
  }
  return {};
}
