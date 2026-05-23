import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { PromptInjectionGuardrail } from 'ottrix/guardrails';
import { GuardrailService } from '../services/guardrail.service.js';

const MAX_BODY_SCAN_BYTES = 256_000;

/** NestJS guard that scans request bodies for prompt injection patterns. */
@Injectable()
export class InjectionGuard implements CanActivate {
  constructor(private readonly guardrails: GuardrailService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      ottrixInjectionDetected?: boolean;
    }>();
    const body = request.body;
    if (!body) {
      return true;
    }

    const mode = this.guardrails.getInjectionMode();
    if (typeof body === 'object' && Array.isArray((body as Record<string, unknown>).messages)) {
      return evaluateMessagesBody(request, body as Record<string, unknown>, mode, this.guardrails.getInjectionGuardrail());
    }

    const text = extractRequestText(body);
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

    if (mode === 'sanitize' && detection.sanitizedContent !== undefined) {
      const applied = applySanitizedBody(body, detection.sanitizedContent);
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
  return false;
}

async function evaluateMessagesBody(
  request: { ottrixInjectionDetected?: boolean },
  body: Record<string, unknown>,
  mode: 'block' | 'flag' | 'sanitize',
  guardrail: PromptInjectionGuardrail,
): Promise<boolean> {
  const messages = body.messages as unknown[];
  let flagged = false;

  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const message = entry as { content?: unknown };
    if (typeof message.content !== 'string') {
      continue;
    }

    if (message.content.length > MAX_BODY_SCAN_BYTES) {
      throw new PayloadTooLargeException('Request body too large for injection scan');
    }

    const detection = await guardrail.checkInput(message.content);
    if (!detection.detected) {
      continue;
    }

    if (mode === 'sanitize' && detection.sanitizedContent !== undefined) {
      message.content = detection.sanitizedContent;
      continue;
    }

    if (mode === 'flag') {
      flagged = true;
      continue;
    }

    throw new ForbiddenException(
      `Prompt injection detected (${detection.category}, severity: ${detection.severity})`,
    );
  }

  if (flagged) {
    request.ottrixInjectionDetected = true;
  }
  return true;
}
