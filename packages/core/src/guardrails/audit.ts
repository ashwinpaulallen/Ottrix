import { randomUUID, createHmac, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getRunContext, type RunContext } from '../context/run-context.js';
import { getLogger } from '../observability/global.js';
import { canonicalStringify } from '../utils/hash.js';

export {
  AuditLogger,
  type AuditLogEntry,
  type AuditLogHandler,
  type AuditLoggerOptions,
  type AuditLogType,
} from './audit-logger.js';

/** Lifecycle event kinds captured by {@link AuditEmitter}. */
export type AuditEventType =
  | 'agent.run.start'
  | 'agent.run.end'
  | 'agent.evaluation.run'
  | 'tool.invoke'
  | 'tool.allow'
  | 'tool.deny'
  | 'tool.success'
  | 'tool.fail'
  | 'guardrail.check'
  | 'guardrail.trip'
  | 'approval.request'
  | 'approval.decide'
  | 'policy.check'
  | 'policy.deny'
  | 'budget.breach'
  | 'budget.warn'
  | 'workflow.step.start'
  | 'workflow.step.end'
  | 'workflow.suspend'
  | 'workflow.resume';

/** Who performed an audited action. */
export interface AuditActor {
  type: 'agent' | 'user' | 'system';
  id: string;
  name?: string;
}

/** Append-only audit record. */
export interface AuditEvent {
  id: string;
  timestamp: number;
  type: AuditEventType;
  actor: AuditActor;
  action: string;
  resource: string;
  outcome: 'success' | 'failure' | 'denied' | 'skipped';
  payload?: Record<string, unknown>;
  runContext?: Partial<RunContext>;
  duration?: number;
  signature?: string;
}

/** Destination for audit events. */
export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
  writeBatch(events: AuditEvent[]): Promise<void>;
  flush(): Promise<void>;
}

/** Optional tamper-evidence signing for audit entries. */
export interface AuditSigner {
  sign(event: Omit<AuditEvent, 'signature'>): string;
  verify(event: AuditEvent): boolean;
}

/** Configuration for {@link AuditEmitter}. */
export interface AuditEmitterConfig {
  sink: AuditSink;
  signer?: AuditSigner;
  redact?: string[];
  filter?: (event: AuditEvent) => boolean;
}

/** User-implemented sink that persists audit events to PostgreSQL. */
export type PostgresSink = AuditSink;

/** User-implemented sink that forwards audit events to a webhook. */
export type WebhookSink = AuditSink;

/** Options for {@link HmacSigner}. */
export interface HmacSignerOptions {
  secret: string;
  algorithm?: 'sha256' | 'sha384' | 'sha512';
}

/** HMAC signer over canonical JSON for tamper-evidence. */
export class HmacSigner implements AuditSigner {
  private readonly secret: string;
  private readonly algorithm: 'sha256' | 'sha384' | 'sha512';

  constructor(options: HmacSignerOptions) {
    this.secret = options.secret;
    this.algorithm = options.algorithm ?? 'sha256';
  }

  sign(event: Omit<AuditEvent, 'signature'>): string {
    return createHmac(this.algorithm, this.secret).update(canonicalStringify(event)).digest('hex');
  }

  verify(event: AuditEvent): boolean {
    const { signature, ...rest } = event;
    if (!signature) {
      return false;
    }
    const expected = this.sign(rest);
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
}

/** Pretty-prints audit events to the console (development). */
export class ConsoleSink implements AuditSink {
  write(event: AuditEvent): Promise<void> {
    console.info('[audit]', JSON.stringify(event, null, 2));
    return Promise.resolve();
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      await this.write(event);
    }
  }

  async flush(): Promise<void> {}
}

/** In-memory sink for tests and inspection. */
export class InMemorySink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  write(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      await this.write(event);
    }
  }

  async flush(): Promise<void> {}

  /** Recorded events in append order. */
  getEvents(): readonly AuditEvent[] {
    return this.events;
  }

  /** Clear recorded events. */
  clear(): void {
    this.events.length = 0;
  }
}

/** Options for {@link FileSink}. */
export interface FileSinkOptions {
  path: string;
}

/** Appends JSON lines to a file (append-only audit trail). */
export class FileSink implements AuditSink {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileSinkOptions) {
    this.path = options.path;
  }

  async write(event: AuditEvent): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  async writeBatch(events: AuditEvent[]): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
      await appendFile(this.path, lines, 'utf8');
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch((error) => {
      getLogger().error('Audit file write failed', {
        error: error instanceof Error ? error.message : String(error),
        path: this.path,
      });
    });
    return next;
  }
}

/**
 * Append-only audit emitter with redaction, optional signing, and fire-and-forget writes.
 */
export class AuditEmitter {
  private readonly sink: AuditSink;
  private readonly signer?: AuditSigner;
  private readonly redactPaths: string[];
  private readonly filter?: (event: AuditEvent) => boolean;

  constructor(config: AuditEmitterConfig) {
    this.sink = config.sink;
    this.signer = config.signer;
    this.redactPaths = config.redact ?? [];
    this.filter = config.filter;
  }

  /** Emit an audit event without blocking the caller. */
  emit(
    partial: Omit<AuditEvent, 'id' | 'timestamp' | 'signature' | 'runContext'> & {
      runContext?: Partial<RunContext>;
    },
  ): void {
    void this.record(partial).catch((error) => {
      getLogger().error('Audit emit failed', {
        error: error instanceof Error ? error.message : String(error),
        type: partial.type,
      });
    });
  }

  /** Flush the configured sink. */
  async flush(): Promise<void> {
    await this.sink.flush();
  }

  private async record(
    partial: Omit<AuditEvent, 'id' | 'timestamp' | 'signature' | 'runContext'> & {
      runContext?: Partial<RunContext>;
    },
  ): Promise<void> {
    const runContext = partial.runContext ?? snapshotRunContext();
    let event: AuditEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      type: partial.type,
      actor: partial.actor,
      action: partial.action,
      resource: partial.resource,
      outcome: partial.outcome,
      payload: partial.payload ? structuredClone(partial.payload) : undefined,
      runContext: runContext ? structuredClone(runContext) : undefined,
      duration: partial.duration,
    };

    if (this.redactPaths.length > 0) {
      event = redactAuditEvent(event, this.redactPaths);
    }

    if (this.filter && !this.filter(event)) {
      return;
    }

    if (this.signer) {
      event.signature = this.signer.sign(event);
    }

    await this.sink.write(event);
  }
}

let globalAuditEmitter: AuditEmitter | undefined;

/** Register the global audit emitter (`ottrix.useAudit(...)`). */
export function useAudit(emitter: AuditEmitter): void {
  globalAuditEmitter = emitter;
}

/** Return the globally registered audit emitter, if any. */
export function getAuditEmitter(): AuditEmitter | undefined {
  return globalAuditEmitter;
}

/** Reset the global audit emitter (tests). */
export function resetAudit(): void {
  globalAuditEmitter = undefined;
}

/** Fire-and-forget helper used by framework internals. */
export function emitAuditEvent(
  partial: Omit<AuditEvent, 'id' | 'timestamp' | 'signature' | 'runContext'> & {
    runContext?: Partial<RunContext>;
  },
): void {
  globalAuditEmitter?.emit(partial);
}

function snapshotRunContext(): Partial<RunContext> | undefined {
  const ctx = getRunContext();
  if (!ctx) {
    return undefined;
  }
  return { ...ctx };
}

function redactAuditEvent(event: AuditEvent, paths: string[]): AuditEvent {
  const next = structuredClone(event);
  for (const path of paths) {
    if (next.payload) {
      redactPath(next.payload, path);
    }
    if (next.runContext) {
      redactPath(next.runContext, path);
    }
  }
  return next;
}

function redactPath(root: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = root;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const value = current[segment];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    current = value as Record<string, unknown>;
  }

  const leaf = segments[segments.length - 1];
  if (leaf in current) {
    current[leaf] = '[REDACTED]';
  }
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  try {
    return cryptoTimingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  } catch {
    return false;
  }
}
