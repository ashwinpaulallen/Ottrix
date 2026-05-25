import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { PromptInjectionGuardrail } from 'ottrix';
import {
  extractMessage,
  isStreamInjectionRequest,
  scanMessageForInjection,
} from 'ottrix/http';
import type { InjectionGuardOptions } from '../interfaces.js';
import { OTTRIX_INJECTION_GUARD_OPTIONS } from '../tokens.js';

/** NestJS guard that scans POST bodies and GET stream queries for prompt injection. */
@Injectable()
export class InjectionGuard implements CanActivate {
  private readonly guardrail: PromptInjectionGuardrail;
  private readonly mode: 'block' | 'flag';
  private readonly bodyField: string;

  constructor(
    @Optional()
    @Inject(OTTRIX_INJECTION_GUARD_OPTIONS)
    options?: InjectionGuardOptions,
  ) {
    this.mode = options?.mode ?? 'block';
    this.bodyField = options?.bodyField ?? 'message';
    this.guardrail = new PromptInjectionGuardrail({ mode: this.mode });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      method?: string;
      path?: string;
      url?: string;
      query?: Record<string, unknown>;
    }>();

    const path = request.path ?? request.url?.split('?')[0] ?? '';
    let message: string | undefined;

    if (request.method === 'GET' && isStreamInjectionRequest(request.method, path)) {
      const parsed = extractMessage({ message: request.query?.message }, this.bodyField);
      if (!parsed.ok) {
        return true;
      }
      message = parsed.message;
    } else {
      const parsed = extractMessage(request.body, this.bodyField);
      if (!parsed.ok) {
        return true;
      }
      message = parsed.message;
    }

    const scan = await scanMessageForInjection(message, {
      mode: this.mode,
      guardrail: this.guardrail,
    });

    if (scan.allowed) {
      return true;
    }

    throw new HttpException(scan.body, scan.status);
  }
}
