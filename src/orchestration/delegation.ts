import { FunctionTool } from '../tools/function-tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JSONSchema } from '../types/tools.js';

/** Name of the delegate tool injected into manager/supervisor agents. */
export const DELEGATE_TOOL_NAME = 'delegate';

/** Parsed input for the delegate tool. */
export interface DelegateToolInput {
  worker: string;
  task: string;
  context?: string;
}

/** Result of parsing raw delegate tool input. */
export type ParsedDelegateInput =
  | { ok: true; input: DelegateToolInput }
  | { ok: false; message: string };

/** Parse and validate delegate tool input from the model. */
export function parseDelegateInput(raw: Record<string, unknown>): ParsedDelegateInput {
  const worker = typeof raw.worker === 'string' ? raw.worker : '';
  const task = typeof raw.task === 'string' ? raw.task : '';
  const context = typeof raw.context === 'string' ? raw.context : undefined;

  if (!worker || !task) {
    return { ok: false, message: 'delegate requires "worker" and "task" string fields' };
  }

  return { ok: true, input: { worker, task, context } };
}

/** Build bullet lines describing available workers. */
export function buildWorkerRosterLines(
  workerNames: string[],
  descriptions?: Map<string, string> | Record<string, string>,
): string[] {
  return workerNames.map((name) => {
    const description =
      descriptions instanceof Map ? descriptions.get(name) : descriptions?.[name];
    return description ? `- ${name}: ${description}` : `- ${name}`;
  });
}

/** Build JSON Schema for the delegate tool. */
export function createDelegateInputSchema(
  workerNames: string[],
  options?: { includeContext?: boolean },
): JSONSchema {
  const properties: JSONSchema['properties'] = {
    worker: {
      type: 'string',
      ...(workerNames.length > 0 ? { enum: workerNames } : {}),
      description: 'Name of the worker agent',
    },
    task: {
      type: 'string',
      description: 'Task description for the worker',
    },
  };

  if (options?.includeContext) {
    properties.context = {
      type: 'string',
      description: 'Optional relevant context to pass to the worker',
    };
  }

  return {
    type: 'object',
    properties,
    required: ['worker', 'task'],
  };
}

/** Register the delegate tool on a shared tool registry. */
export function registerDelegateTool(
  registry: ToolRegistry,
  workerNames: string[],
  execute: (input: DelegateToolInput) => Promise<string>,
  options?: {
    includeContext?: boolean;
    description?: string;
  },
): void {
  const delegateTool = new FunctionTool({
    name: DELEGATE_TOOL_NAME,
    description:
      options?.description ??
      'Delegate a subtask to a specialist worker agent and return its response.',
    inputSchema: createDelegateInputSchema(workerNames, options),
    execute: async (raw) => {
      const parsed = parseDelegateInput(raw);
      if (!parsed.ok) {
        return parsed.message;
      }
      return execute(parsed.input);
    },
  });

  registry.register(delegateTool, { onDuplicate: 'overwrite' });
}

/** Resolve a tool registry from explicit config or an agent instance. */
export function requireToolRegistry(
  registry: ToolRegistry | undefined,
  fromAgent: ToolRegistry | undefined,
  workflowName: string,
): ToolRegistry {
  const resolved = registry ?? fromAgent;
  if (!resolved) {
    throw new Error(`${workflowName} requires a ToolRegistry on the manager agent (config.toolRegistry)`);
  }
  return resolved;
}

/** Message returned when the delegate tool exceeds its invocation limit. */
export function delegateLimitMessage(max: number): string {
  return (
    `Maximum delegation rounds (${max}) exceeded. ` +
    'Please provide your final answer based on the information gathered so far.'
  );
}

/** Message returned when the delegate tool references an unknown worker. */
export function unknownWorkerMessage(worker: string, available: string[]): string {
  return `Unknown worker "${worker}". Available workers: ${available.join(', ')}`;
}

/** Message returned when a worker fails or times out. */
export function workerFailureMessage(worker: string, message: string): string {
  return `The ${worker} encountered an error: ${message}. Try a different approach.`;
}
