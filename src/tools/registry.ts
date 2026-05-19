import type { ToolDefinition, ToolResult } from '../types/tools.js';
import { runToolSpan } from '../observability/instrument.js';
import type { Telemetry } from '../observability/telemetry.js';
import { BaseTool } from './tool.js';
import { FunctionTool } from './function-tool.js';

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
    } = {},
  ) {
    this.defaultDuplicateStrategy = options.onDuplicate ?? 'overwrite';
    this.telemetry = options.telemetry;
    this.telemetryComponent = options.component ?? 'tools';

    if (options.cloneFrom) {
      for (const name of options.cloneFrom.names()) {
        const tool = options.cloneFrom.get(name);
        if (tool) {
          this.tools.set(name, tool);
        }
      }
    }
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
   * @throws If no tool is registered for `name`.
   */
  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    if (!this.telemetry) {
      return tool.execute(input);
    }

    return runToolSpan(this.telemetry, this.telemetryComponent, name, async () => {
      const result = await tool.execute(input);
      return result;
    });
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
}
