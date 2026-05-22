import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { GuardrailService } from '../services/guardrail.service.js';

const MAX_BODY_SCAN_BYTES = 256_000;

/** NestJS guard that scans request bodies for prompt injection patterns. */
@Injectable()
export class InjectionGuard implements CanActivate {
  constructor(private readonly guardrails: GuardrailService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    const text = extractRequestText(request.body);
    if (!text) {
      return true;
    }

    if (text.length > MAX_BODY_SCAN_BYTES) {
      throw new PayloadTooLargeException('Request body too large for injection scan');
    }

    const detection = await this.guardrails.getInjectionGuardrail().checkInput(text);
    if (!detection.detected) {
      return true;
    }

    const mode = this.guardrails.getInjectionMode();

    if (mode === 'sanitize' && detection.sanitizedContent !== undefined && request.body) {
      const applied = applySanitizedBody(request.body, detection.sanitizedContent);
      if (!applied) {
        throw new ForbiddenException(
          `Prompt injection detected (${detection.category}, severity: ${detection.severity})`,
        );
      }
      return true;
    }

    if (mode === 'flag') {
      (request as { ottrixInjectionDetected?: boolean }).ottrixInjectionDetected = true;
      return true;
    }

    throw new ForbiddenException(
      `Prompt injection detected (${detection.category}, severity: ${detection.severity})`,
    );
  }
}

function extractRequestText(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body;
  }
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') {
    return record.message;
  }
  if (typeof record.prompt === 'string') {
    return record.prompt;
  }
  if (typeof record.input === 'string') {
    return record.input;
  }

  if (Array.isArray(record.messages)) {
    const parts: string[] = [];
    for (const entry of record.messages) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const message = entry as Record<string, unknown>;
      if (typeof message.content === 'string') {
        parts.push(message.content);
      }
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return JSON.stringify(body);
}

function applySanitizedBody(body: unknown, sanitized: string): boolean {
  if (typeof body === 'string') {
    return false;
  }
  if (!body || typeof body !== 'object') {
    return false;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') {
    record.message = sanitized;
    return true;
  }
  if (typeof record.prompt === 'string') {
    record.prompt = sanitized;
    return true;
  }
  if (typeof record.input === 'string') {
    record.input = sanitized;
    return true;
  }
  if (Array.isArray(record.messages)) {
    for (const entry of record.messages) {
      if (entry && typeof entry === 'object' && typeof (entry as { content?: unknown }).content === 'string') {
        (entry as { content: string }).content = sanitized;
        return true;
      }
    }
  }
  return false;
}
