import { BaseTool, type BaseToolConfig } from './tool.js';

/**
 * Function invoked by {@link FunctionTool} after input validation.
 */
export type ToolExecuteFn = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Configuration for {@link FunctionTool}.
 */
export interface FunctionToolConfig extends BaseToolConfig {
  /** Implementation called by {@link FunctionTool._execute}. */
  execute: ToolExecuteFn;
}

/**
 * Tool implementation that wraps an arbitrary async function.
 *
 * @example
 * ```ts
 * const calculator = new FunctionTool({
 *   name: 'calculator',
 *   description: 'Performs math operations',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { expression: { type: 'string' } },
 *     required: ['expression'],
 *   },
 *   execute: async ({ expression }) => evaluateExpression(String(expression)),
 * });
 * ```
 */
export class FunctionTool extends BaseTool {
  private readonly executeFn: ToolExecuteFn;

  /**
   * @param config - Tool metadata plus the `execute` function.
   */
  constructor(config: FunctionToolConfig) {
    super(config);
    this.executeFn = config.execute;
  }

  /** @inheritdoc */
  protected _execute(input: Record<string, unknown>): Promise<unknown> {
    return this.executeFn(input);
  }
}
