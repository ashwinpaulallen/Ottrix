import {
  PromptInjectionGuardrail,
  type InjectionDetection,
} from '../guardrails/injection.js';
import { InjectionDetectedError, mapOttrixError } from './errors.js';

/** Options for {@link scanMessageForInjection}. */
export interface ScanInjectionOptions {
  mode?: 'block' | 'flag';
  guardrail?: PromptInjectionGuardrail;
}

/** Result of scanning a user message for prompt injection. */
export type ScanInjectionResult =
  | { allowed: true; flagged?: undefined }
  | { allowed: true; flagged: InjectionDetection }
  | { allowed: false; status: number; body: { error: string; code: string } };

/**
 * Scan a user message with {@link PromptInjectionGuardrail}.
 * Shared by POST body middleware and GET `/stream?message=` handlers.
 */
export async function scanMessageForInjection(
  message: string,
  options: ScanInjectionOptions = {},
): Promise<ScanInjectionResult> {
  const mode = options.mode ?? 'block';
  const guardrail = options.guardrail ?? new PromptInjectionGuardrail({ mode });
  const detection = await guardrail.checkInput(message);

  if (!detection.detected) {
    return { allowed: true };
  }

  if (mode === 'flag') {
    return { allowed: true, flagged: detection };
  }

  const mapped = mapOttrixError(new InjectionDetectedError('injection detected'));
  return { allowed: false, status: mapped.status, body: mapped.body };
}

/** Whether a request should scan the `message` query param for injection. */
export function isStreamInjectionRequest(method: string, path: string): boolean {
  return method === 'GET' && path.endsWith('/stream');
}
