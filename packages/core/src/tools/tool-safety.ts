import type {
  AuditConfig,
  ToolAuditEvent,
  ToolDescriptor,
  ToolMetadata,
  ToolResult,
} from '../types/tools.js';
import type { MCPToolDefinition } from './mcp/types.js';
import type { BaseTool } from './tool.js';
import { zodToJsonSchema } from '../utils/zod-to-json-schema.js';
import type { ZodType } from 'zod';

/** Default safety metadata applied when fields are omitted. */
export const DEFAULT_TOOL_SAFETY: Required<
  Pick<ToolMetadata, 'sideEffect' | 'idempotent' | 'requiresApproval' | 'requiresSandbox'>
> = {
  sideEffect: 'none',
  idempotent: false,
  requiresApproval: false,
  requiresSandbox: false,
};

/** Error details name for safety middleware blocks. */
export const TOOL_SAFETY_BLOCKED_NAME = 'ToolSafetyBlocked';

/** Built-in pattern for common destructive MCP tool names. */
export const MCP_DESTRUCTIVE_NAME_PATTERN = /delete|drop|force|deploy|merge/i;

/** Subset of destructive names that default to requiring approval. */
export const MCP_APPROVAL_NAME_PATTERN = /delete|drop|deploy/i;

/** Optional safety fields accepted by {@link createTool} / {@link ZodTool}. */
export interface ToolSafetyFields {
  sideEffect?: ToolMetadata['sideEffect'];
  idempotent?: boolean;
  requiresApproval?: ToolMetadata['requiresApproval'];
  requiresSandbox?: boolean;
  audit?: AuditConfig;
  version?: string;
}

/** Whether `requiresApproval` is enabled (boolean or structured requirement). */
export function requiresApprovalEnabled(
  value?: ToolMetadata['requiresApproval'],
): boolean {
  return value !== undefined && value !== false;
}

/**
 * Normalize tool metadata with safe defaults.
 * Missing fields use values that preserve backward-compatible behavior.
 */
export function normalizeToolMetadata(metadata?: ToolMetadata): ToolMetadata {
  return {
    ...DEFAULT_TOOL_SAFETY,
    ...metadata,
  };
}

/** Log a registration warning when a destructive tool lacks approval gates. */
export function warnDestructiveWithoutApproval(
  toolName: string,
  metadata: ToolMetadata | undefined,
  warn: (message: string) => void,
): void {
  const normalized = normalizeToolMetadata(metadata);
  if (
    normalized.sideEffect === 'destructive' &&
    !requiresApprovalEnabled(normalized.requiresApproval)
  ) {
    warn(`Tool '${toolName}' is marked destructive but does not require approval`);
  }
}

/** Build a {@link ToolDescriptor} from a registered {@link BaseTool}. */
export function buildToolDescriptor(tool: BaseTool): ToolDescriptor {
  const metadata = normalizeToolMetadata(tool.metadata);
  const descriptor: ToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    safety: {
      sideEffect: metadata.sideEffect ?? 'none',
      idempotent: metadata.idempotent ?? false,
      requiresApproval: metadata.requiresApproval ?? false,
      requiresSandbox: metadata.requiresSandbox ?? false,
    },
    version: metadata.version,
  };

  if ('zodOutputSchema' in tool && tool.zodOutputSchema) {
    descriptor.outputSchema = zodToJsonSchema(tool.zodOutputSchema as ZodType<unknown>);
  }

  return descriptor;
}

/**
 * Filter tool input for audit logging according to {@link AuditConfig}.
 * `exclude` wins over `include` when both are set for a field.
 */
export function applyAuditFilter(
  input: Record<string, unknown>,
  audit?: AuditConfig,
): Record<string, unknown> {
  if (!audit?.include?.length && !audit?.exclude?.length) {
    return { ...input };
  }

  const excluded = new Set(audit.exclude ?? []);
  const keys =
    audit.include?.length && audit.include.length > 0
      ? audit.include
      : Object.keys(input);

  const filtered: Record<string, unknown> = {};
  for (const key of keys) {
    if (excluded.has(key)) {
      filtered[key] = '[REDACTED]';
    } else if (key in input) {
      filtered[key] = input[key];
    }
  }

  for (const key of excluded) {
    if (!(key in filtered) && key in input) {
      filtered[key] = '[REDACTED]';
    }
  }

  return filtered;
}

/** Default classifier for unknown MCP tools. */
export function defaultMcpToolClassifier(tool: MCPToolDefinition): Partial<ToolMetadata> {
  const isDestructive = MCP_DESTRUCTIVE_NAME_PATTERN.test(tool.name);
  const needsApproval = MCP_APPROVAL_NAME_PATTERN.test(tool.name);
  return {
    sideEffect: isDestructive ? 'destructive' : 'write',
    requiresApproval: needsApproval,
  };
}

/** Merge explicit MCP classify output with defaults. */
export function classifyMcpToolMetadata(
  tool: MCPToolDefinition,
  classify?: (tool: MCPToolDefinition) => Partial<ToolMetadata>,
): ToolMetadata {
  const classified = classify?.(tool) ?? defaultMcpToolClassifier(tool);
  return normalizeToolMetadata({
    sideEffect: 'write',
    ...classified,
  });
}

/** Build a blocked {@link ToolResult} from safety middleware. */
export function buildSafetyBlockedResult(message: string, code: string): ToolResult {
  return {
    success: false,
    output: null,
    error: message,
    errorDetails: {
      name: TOOL_SAFETY_BLOCKED_NAME,
      data: { code, blocked: true },
    },
  };
}

/** Resolve sandbox availability from a static flag or callback. */
export async function resolveSandboxAvailable(
  sandboxAvailable?: boolean | (() => boolean | Promise<boolean>),
): Promise<boolean> {
  if (sandboxAvailable === undefined) {
    return false;
  }
  if (typeof sandboxAvailable === 'function') {
    return sandboxAvailable();
  }
  return sandboxAvailable;
}

export type { ToolAuditEvent };
