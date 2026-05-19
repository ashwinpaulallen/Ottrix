import { appendFile } from 'node:fs/promises';
import type { TokenUsage } from '../types/provider.js';
import type { GuardrailDecision, GuardrailHandler, LlmGuardrailContext, ToolGuardrailContext } from './types.js';

/** Kind of audit log entry. */
export type AuditLogType =
  | 'llm_pre'
  | 'llm_post'
  | 'tool_pre'
  | 'tool_post'
  | 'guardrail_decision';

/** Single audit log record. */
export interface AuditLogEntry {
  timestamp: string;
  type: AuditLogType;
  agentName: string;
  details: Record<string, unknown>;
  tokenUsage?: TokenUsage;
  duration?: number;
}

/** Sink for audit log entries. */
export type AuditLogHandler = (entry: AuditLogEntry) => void | Promise<void>;

/** Options for {@link AuditLogger}. */
export interface AuditLoggerOptions {
  agentName?: string;
  console?: boolean;
  filePath?: string;
  handler?: AuditLogHandler;
}

/**
 * Logs LLM calls, tool executions, and guardrail decisions.
 */
export class AuditLogger implements GuardrailHandler {
  readonly name = 'audit';
  private readonly agentName: string;
  private readonly consoleEnabled: boolean;
  private readonly filePath?: string;
  private readonly handler?: AuditLogHandler;
  private readonly entries: AuditLogEntry[] = [];

  constructor(options: AuditLoggerOptions = {}) {
    this.agentName = options.agentName ?? 'agent';
    this.consoleEnabled = options.console ?? false;
    this.filePath = options.filePath;
    this.handler = options.handler;
  }

  /** All entries recorded in this logger instance. */
  getLogs(): readonly AuditLogEntry[] {
    return this.entries;
  }

  /** Export logs as JSON for analysis. */
  exportLogs(pretty = false): string {
    return JSON.stringify(this.entries, null, pretty ? 2 : undefined);
  }

  /** Clear in-memory entries. */
  clear(): void {
    this.entries.length = 0;
  }

  async beforeLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    await this.record({
      type: 'llm_pre',
      agentName: context.agentName,
      details: {
        messageCount: context.messages.length,
        toolCount: context.params.tools?.length ?? 0,
      },
    });
  }

  async afterLlm(context: LlmGuardrailContext): Promise<GuardrailDecision | void> {
    await this.record({
      type: 'llm_post',
      agentName: context.agentName,
      details: {
        stopReason: context.result?.stopReason,
        model: context.result?.model,
      },
      tokenUsage: context.result?.usage,
      duration: context.durationMs,
    });
  }

  async beforeTool(context: ToolGuardrailContext): Promise<GuardrailDecision | void> {
    await this.record({
      type: 'tool_pre',
      agentName: context.agentName,
      details: {
        toolName: context.toolName,
        input: context.input,
      },
    });
  }

  async afterTool(context: ToolGuardrailContext): Promise<GuardrailDecision | void> {
    await this.record({
      type: 'tool_post',
      agentName: context.agentName,
      details: {
        toolName: context.toolName,
        success: !context.error,
        error: context.error,
        output: context.output,
      },
      duration: context.durationMs,
    });
  }

  /** Log an explicit guardrail decision. */
  async logDecision(
    agentName: string,
    guardrailName: string,
    decision: GuardrailDecision,
  ): Promise<void> {
    await this.record({
      type: 'guardrail_decision',
      agentName,
      details: {
        guardrail: guardrailName,
        action: decision.action,
        reason: decision.reason,
        flags: decision.flags,
      },
    });
  }

  private async record(
    partial: Omit<AuditLogEntry, 'timestamp'> & { timestamp?: string },
  ): Promise<void> {
    const entry: AuditLogEntry = {
      timestamp: partial.timestamp ?? new Date().toISOString(),
      type: partial.type,
      agentName: partial.agentName || this.agentName,
      details: partial.details,
      tokenUsage: partial.tokenUsage,
      duration: partial.duration,
    };

    this.entries.push(entry);

    if (this.consoleEnabled) {
      console.info('[audit]', JSON.stringify(entry));
    }

    if (this.handler) {
      await this.handler(entry);
    }

    if (this.filePath) {
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    }
  }
}
