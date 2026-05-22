import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { defer, from, lastValueFrom } from 'rxjs';
import { RunContextService } from '../services/run-context.service.js';

/** Establishes Ottrix {@link RunContext} for each HTTP request via ALS. */
@Injectable()
export class RunContextInterceptor implements NestInterceptor {
  constructor(private readonly runContextService: RunContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.runContextService.isEnabled()) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      user?: { orgId?: string; id?: string; agentName?: string };
    }>();

    const runContext = this.runContextService.contextFromRequest(request);
    if (request.user?.agentName) {
      runContext.agentName = request.user.agentName;
    }

    return defer(() =>
      from(this.runContextService.runWith(runContext, () => lastValueFrom(next.handle()))),
    );
  }
}
