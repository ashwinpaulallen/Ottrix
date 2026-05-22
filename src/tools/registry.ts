import type {
  ApprovalHandler,
  ToolDefinition,
  ToolExecuteOptions,
  ToolResult,
} from '../types/tools.js';
import { runToolSpan } from '../observability/instrument.js';
import type { Telemetry } from '../observability/telemetry.js';
import { ConfigurationError } from './errors.js';
import { BaseTool } from './tool.js';
import { FunctionTool } from './function-tool.js';
import { isZodTool, type AnyZodSchema } from './zod-tool.js';
import {
  buildApprovalRequest,
  buildToolApprovalDeniedResult,
  resolveApprovedInput,
} from './tool-approval.js';

/** Behavior when registering a tool whose name is already taken. */
export type ToolRegistryOnDuplicate = 'overwrite' | 'ignore' | 'throw';

/** Options for {@link ToolRegistry.register}. */
export interface ToolRegistryRegisterOptions {
  /** Strategy when a tool with the same name already exists. @defaultValue 'overwrite' */
  onDuplicate?: ToolRegistryOnDuplicate;
}

/** Error thrown when registering a tool with a duplicate name under `'throw'` strategy. */
export class DuplicateToolError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" is already registered`);
    this.name = 'DuplicateToolError';
    this.toolName = toolName;
  }
}

/** Error thrown when executing or resolving an unknown tool name. */
export class ToolNotFoundError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" is not registered`);
    this.name = 'ToolNotFoundError';
    this.toolName = toolName;
  }
}

/**
 * Registry for discovering and executing tools by name.
 *
 * Supports namespaced tool names such as `namespace.toolName`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, BaseTool>();
  private readonly defaultDuplicateStrategy: ToolRegistryOnDuplicate;
  private readonly telemetry?: Telemetry;
  private readonly telemetryComponent: string;
  private globalApprovalHandler?: ApprovalHandler;
  private readonly toolApprovalHandlers = new Map<string, ApprovalHandler>();

  /**
   * @param options - Default duplicate-handling strategy (`'overwrite'` for legacy behavior).
   */
  constructor(
    options: {
      onDuplicate?: ToolRegistryOnDuplicate;
      /** When set, creates spans for each {@link ToolRegistry.execute} call. */
      telemetry?: Telemetry;
      /** Component label on tool spans. @defaultValue 'tools' */
      component?: string;
      /** Copy tools from an existing registry (used by instrumentation wrappers). */
      cloneFrom?: ToolRegistry;
      /** Initial global approval handler. */
      approvalHandler?: ApprovalHandler;
    } = {},
  ) {
    this.defaultDuplicateStrategy = options.onDuplicate ?? 'overwrite';
    this.telemetry = options.telemetry;
    this.telemetryComponent = options.component ?? 'tools';
    this.globalApprovalHandler = options.approvalHandler;

    if (options.cloneFrom) {
      for (const name of options.cloneFrom.names()) {
        const tool = options.cloneFrom.get(name);
        if (tool) {
          this.tools.set(name, tool);
        }
      }
      const clonedHandler = options.cloneFrom.getGlobalApprovalHandler();
      if (clonedHandler) {
        this.globalApprovalHandler = clonedHandler;
      }
      for (const name of options.cloneFrom.names()) {
        const handler = options.cloneFrom.getToolApprovalHandler(name);
        if (handler) {
          this.toolApprovalHandlers.set(name, handler);
        }
      }
    }
  }

  /** Returns the global approval handler, if set. */
  getGlobalApprovalHandler(): ApprovalHandler | undefined {
    return this.globalApprovalHandler;
  }

  /** Returns a per-tool approval handler override, if set. */
  getToolApprovalHandler(toolName: string): ApprovalHandler | undefined {
    return this.toolApprovalHandlers.get(toolName);
  }

  /** Register a global approval handler for tools with `requiresApproval`. */
  setApprovalHandler(handler: ApprovalHandler): this {
    this.globalApprovalHandler = handler;
    return this;
  }

  /** Register a per-tool approval handler (overrides the global handler for that tool). */
  setToolApprovalHandler(toolName: string, handler: ApprovalHandler): this {
    this.assertRegistered(toolName);
    this.toolApprovalHandlers.set(toolName, handler);
    return this;
  }

  /**
   * Register a tool instance.
   *
   * @param tool - Tool to register.
   * @param options - Override duplicate strategy for this call.
   * @throws {DuplicateToolError} when the strategy is `'throw'` and the name exists.
   */
  register(tool: BaseTool, options: ToolRegistryRegisterOptions = {}): this {
    if (this.tools.has(tool.name)) {
      const strategy = options.onDuplicate ?? this.defaultDuplicateStrategy;
      if (strategy === 'throw') {
        throw new DuplicateToolError(tool.name);
      }
      if (strategy === 'ignore') {
        return this;
      }
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /**
   * Remove a tool by name.
   *
   * @returns `true` if a tool was removed.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Look up a registered tool by name (including namespaced names).
   */
  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Whether a tool is registered under `name`.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Return tool definitions for LLM / provider registration.
   */
  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.toDefinition());
  }

  /**
   * Return the Zod input schema for a tool registered via {@link ZodTool} / {@link createTool}.
   *
   * @returns The schema, or `undefined` for legacy JSON Schema tools.
   */
  getZodSchema(toolName: string): AnyZodSchema | undefined {
    const tool = this.tools.get(toolName);
    if (!tool || !isZodTool(tool)) {
      return undefined;
    }
    return tool.zodSchema;
  }

  /**
   * Return registered tool names.
   */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Whether this registry already records spans with the given telemetry instance. */
  usesTelemetry(telemetry: Telemetry): boolean {
    return this.telemetry === telemetry;
  }

  /**
   * Execute a tool by name with validated input.
   *
   * Tools with `requiresApproval` invoke an {@link ApprovalHandler} before running.
   *
   * @throws {ToolNotFoundError} If no tool is registered for `name`.
   * @throws {ConfigurationError} If approval is required but no handler is registered.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    const run = async (): Promise<ToolResult> => {
      if (!tool.requiresApproval) {
        return tool.execute(input);
      }

      const handler = this.resolveApprovalHandler(tool);
      if (!handler) {
        throw new ConfigurationError(
          `Tool '${name}' requires approval but no ApprovalHandler is registered`,
        );
      }

      const approval = await handler(
        buildApprovalRequest(name, input, {
          agentName: options?.agentName,
          stepNumber: options?.stepNumber,
          context: options?.context,
        }),
      );

      if (!approval.approved) {
        return buildToolApprovalDeniedResult(approval.reason);
      }

      const effectiveInput = resolveApprovedInput(input, approval);
      return tool.execute(effectiveInput);
    };

    if (!this.telemetry) {
      return run();
    }

    return runToolSpan(this.telemetry, this.telemetryComponent, name, run);
  }

  /**
   * Dynamically register a tool from a schema and executor function.
   */
  registerFromSchema(
    schema: ToolDefinition,
    executor: (input: Record<string, unknown>) => Promise<unknown>,
  ): this {
    const tool = new FunctionTool({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      metadata: schema.metadata,
      execute: executor,
    });
    return this.register(tool);
  }

  /**
   * List tools whose names share a namespace prefix (`namespace.`).
   */
  listByNamespace(namespace: string): ToolDefinition[] {
    const prefix = `${namespace}.`;
    return this.list().filter((def) => def.name.startsWith(prefix));
  }

  /**
   * Unregister all tools in a namespace.
   */
  unregisterNamespace(namespace: string): number {
    const prefix = `${namespace}.`;
    let removed = 0;
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  private resolveApprovalHandler(tool: BaseTool): ApprovalHandler | undefined {
    return (
      tool.approvalHandler ??
      this.toolApprovalHandlers.get(tool.name) ??
      this.globalApprovalHandler
    );
  }

  private assertRegistered(name: string): void {
    if (!this.tools.has(name)) {
      throw new ToolNotFoundError(name);
    }
  }
}
