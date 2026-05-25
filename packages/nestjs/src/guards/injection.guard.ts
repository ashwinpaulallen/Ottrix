import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { getLogger, PromptInjectionGuardrail } from 'ottrix';
import type { InjectionGuardOptions } from '../interfaces.js';
import { OTTRIX_INJECTION_GUARD_OPTIONS } from '../tokens.js';

/** NestJS guard that scans request bodies for prompt injection patterns. */
@Injectable()
export class InjectionGuard implements CanActivate {
  private readonly guardrail: PromptInjectionGuardrail;
  private readonly mode: 'block' | 'flag';
  private readonly bodyField: string;
  private readonly logger = getLogger().child({ integration: 'nestjs', guard: 'injection' });

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
    const request = context.switchToHttp().getRequest<{ body?: Record<string, unknown> }>();
    const body = request.body;
    if (!body || typeof body !== 'object') {
      return true;
    }

    const message = body[this.bodyField];
    if (typeof message !== 'string' || message.length === 0) {
      return true;
    }

    const detection = await this.guardrail.checkInput(message);
    if (!detection.detected) {
      return true;
    }

    if (this.mode === 'flag') {
      this.logger.warn('Prompt injection flagged', {
        category: detection.category,
        severity: detection.severity,
      });
      return true;
    }

    throw new ForbiddenException(
      `Prompt injection detected (${detection.category}, severity: ${detection.severity})`,
    );
  }
}
