import type {
  ApprovalHandler,
  ToolAuditEvent,
  ToolDefinition,
  ToolDescriptor,
  ToolExecuteOptions,
  ToolResult,
} from '../types/tools.js';
import { Logger } from '../observability/logger.js';
import { emitAuditEvent } from '../guardrails/audit.js';
import { runToolSpan } from '../observability/instrument.js';
import { getMetricsCollector } from '../observability/global.js';
import type { Telemetry } from '../observability/telemetry.js';
import {
  CAPABILITY,
  withCapabilityScope,
} from '../observability/token-accounting/index.js';
import { ConfigurationError } from './errors.js';
import { BaseTool } from './tool.js';
import { FunctionTool } from './function-tool.js';
import { isZodTool, type AnyZodSchema } from './zod-tool.js';
import {
  buildApprovalRequest,
  buildToolApprovalDeniedResult,
  resolveApprovedInput,
} from './tool-approval.js';
import {
  applyAuditFilter,
  buildSafetyBlockedResult,
  buildToolDescriptor,
  normalizeToolMetadata,
  requiresApprovalEnabled,
  resolveSandboxAvailable,
  warnDestructiveWithoutApproval,
} from './tool-safety.js';
import {
  buildIdempotencyInProgressResult,
  computeIdempotencyKey,
  getIdempotencyOptions,
  isIdempotentTool,
  resolveIdempotencyStore,
  waitForIdempotencyResult,
  type IdempotencyExecutionOptions,
  type IdempotencyKeyFn,
  type IdempotencyStore,
} from './idempotency.js';

/** Behavior when registering a tool whose name is already taken. */
export type ToolRegistryOnDuplicate = 'overwrite' | 'ignore' | 'throw';

/** Options for {@link ToolRegistry.register}. */
export interface ToolRegistryRegisterOptions {
  /** Strategy when a tool with the same name already exists. @defaultValue 'overwrite' */
  onDuplicate?: ToolRegistryOnDuplicate;
}

/** Sink for post-execution tool audit events. */
export type ToolAuditHandler = (event: ToolAuditEvent) => void | Promise<void>;

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
  private readonly logger: Logger;
  private readonly auditHandler?: ToolAuditHandler;
  private readonly sandboxAvailable?: boolean | (() => boolean | Promise<boolean>);
  private readonly idempotencyStore?: IdempotencyStore;
  private readonly idempotencyOptions: IdempotencyExecutionOptions;

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
      /** Post-execution audit sink for tools with {@link AuditConfig}. */
      auditHandler?: ToolAuditHandler;
      /** Whether a sandbox is available for `requiresSandbox` tools. */
      sandboxAvailable?: boolean | (() => boolean | Promise<boolean>);
      /** Logger for registration warnings. */
      logger?: Logger;
      /** Global idempotency ledger for tools marked `idempotent: true`. */
      idempotencyStore?: IdempotencyStore;
      /** Retry timing when an idempotency key is already in progress. */
      idempotencyOptions?: IdempotencyExecutionOptions;
    } = {},
  ) {
    this.defaultDuplicateStrategy = options.onDuplicate ?? 'overwrite';
    this.telemetry = options.telemetry;
    this.telemetryComponent = options.component ?? 'tools';
    this.globalApprovalHandler = options.approvalHandler;
    this.auditHandler = options.auditHandler;
    this.sandboxAvailable = options.sandboxAvailable;
    this.idempotencyStore = options.idempotencyStore;
    this.idempotencyOptions = {
      ...getIdempotencyOptions(),
      ...options.idempotencyOptions,
    };
    this.logger = options.logger ?? new Logger({ component: 'ToolRegistry' });

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

    warnDestructiveWithoutApproval(tool.name, tool.metadata, (message) => {
      this.logger.warn(message, { toolName: tool.name });
    });

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
   * Return complete descriptors including safety metadata for every registered tool.
   */
  toolDescriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => buildToolDescriptor(tool));
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
   * Destructive tools run additional safety checks unless {@link ToolExecuteOptions.skipSafetyChecks}
   * is set.
   *
   * @throws {ToolNotFoundError} If no tool is registered for `name`.
   * @throws {ConfigurationError} If approval is required but no handler is registered.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const capability = `${CAPABILITY.TOOL_PREFIX}${name}`;
    return withCapabilityScope(capability, () => this.executeInScope(name, input, options));
  }

  private async executeInScope(
    name: string,
    input: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    const agentName = options?.agentName;
    const actor = toolAuditActor(agentName);
    const resource = `tool:${name}`;

    const run = async (): Promise<ToolResult> => {
      const metadata = normalizeToolMetadata(tool.metadata);
      const skipSafety = options?.skipSafetyChecks === true;
      let effectiveInput = input;
      let approvalHandled = false;
      const invokeStarted = performance.now();

      if (!skipSafety && metadata.sideEffect === 'destructive') {
        emitAuditEvent({
          type: 'policy.check',
          actor,
          action: 'check',
          resource,
          outcome: 'success',
          payload: { sideEffect: metadata.sideEffect, requiresSandbox: metadata.requiresSandbox },
        });

        if (metadata.requiresSandbox) {
          const available = await resolveSandboxAvailable(this.sandboxAvailable);
          if (!available) {
            emitToolDeny(actor, resource, 'sandbox_required');
            emitPolicyDeny(actor, resource, 'sandbox_required');
            return buildSafetyBlockedResult(
              `Tool '${name}' is destructive and requires a sandbox, but none is available`,
              'sandbox_required',
            );
          }
        }

        if (requiresApprovalEnabled(metadata.requiresApproval)) {
          const approvalOutcome = await this.runApprovalGate(name, tool, effectiveInput, options);
          if (approvalOutcome.result) {
            await this.emitToolAudit(tool, effectiveInput, approvalOutcome.result, agentName);
            return approvalOutcome.result;
          }
          effectiveInput = approvalOutcome.input;
          approvalHandled = true;
          emitToolAllow(actor, resource);
        } else {
          emitToolAllow(actor, resource);
        }
      }

      if (tool.requiresApproval && !approvalHandled) {
        const approvalOutcome = await this.runApprovalGate(name, tool, effectiveInput, options);
        if (approvalOutcome.result) {
          await this.emitToolAudit(tool, effectiveInput, approvalOutcome.result, agentName);
          return approvalOutcome.result;
        }
        effectiveInput = approvalOutcome.input;
        emitToolAllow(actor, resource);
      }

      emitAuditEvent({
        type: 'tool.invoke',
        actor,
        action: 'invoke',
        resource,
        outcome: 'success',
        payload: { args: effectiveInput },
      });

      const result = await this.runWithIdempotency(name, tool, effectiveInput, () =>
        tool.execute(effectiveInput),
      );

      emitAuditEvent({
        type: result.success ? 'tool.success' : 'tool.fail',
        actor,
        action: result.success ? 'execute' : 'fail',
        resource,
        outcome: result.success ? 'success' : 'failure',
        duration: performance.now() - invokeStarted,
        payload: result.success ? undefined : { error: result.error },
      });

      await this.emitToolAudit(tool, effectiveInput, result, agentName);
      return result;
    };

    const recordMetrics = async (): Promise<ToolResult> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        getMetricsCollector().record('tool_execution_ms', performance.now() - started, {
          tool: name,
        });
      }
    };

    if (!this.telemetry) {
      return recordMetrics();
    }

    return runToolSpan(this.telemetry, this.telemetryComponent, name, recordMetrics);
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

  private async runWithIdempotency(
    name: string,
    tool: BaseTool,
    input: Record<string, unknown>,
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (!isIdempotentTool(tool)) {
      return execute();
    }

    const store = resolveIdempotencyStore(this.getToolIdempotencyStore(tool), this.idempotencyStore);
    if (!store) {
      this.logger.warn(`Idempotent tool "${name}" has no IdempotencyStore configured`);
      return execute();
    }

    const key = computeIdempotencyKey(
      name,
      input,
      this.getToolIdempotencyKeyFn(tool),
      this.logger,
    );

    let check = await store.begin(key);
    if (check.status === 'done') {
      this.emitIdempotencyHit(name, key);
      return check.result as ToolResult;
    }

    if (check.status === 'in_progress') {
      check = await waitForIdempotencyResult(store, key, this.idempotencyOptions);
      if (check.status === 'done') {
        this.emitIdempotencyHit(name, key);
        return check.result as ToolResult;
      }
      if (check.status === 'in_progress') {
        return buildIdempotencyInProgressResult(name, key);
      }
    }

    try {
      const result = await execute();
      if (result.success) {
        await store.complete(key, result);
      } else {
        await store.fail(key, result.error);
      }
      return result;
    } catch (error) {
      await store.fail(key, error);
      throw error;
    }
  }

  private getToolIdempotencyStore(tool: BaseTool): IdempotencyStore | undefined {
    if (isZodTool(tool)) {
      return tool.idempotencyStore;
    }
    return undefined;
  }

  private getToolIdempotencyKeyFn(tool: BaseTool): IdempotencyKeyFn | undefined {
    if (isZodTool(tool)) {
      return tool.idempotencyKey;
    }
    return undefined;
  }

  private emitIdempotencyHit(toolName: string, key: string): void {
    this.telemetry?.activeSpan?.addEvent('tool_idempotency_hit', {
      type: 'tool_idempotency_hit',
      toolName,
      key: key.slice(0, 64),
    });
  }

  private async runApprovalGate(
    name: string,
    tool: BaseTool,
    input: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<{ input: Record<string, unknown>; result?: ToolResult }> {
    const handler = this.resolveApprovalHandler(tool);
    const agentName = options?.agentName;
    const actor = toolAuditActor(agentName);
    const resource = `tool:${name}`;

    if (!handler) {
      const metadata = normalizeToolMetadata(tool.metadata);
      if (metadata.sideEffect === 'destructive') {
        emitToolDeny(actor, resource, 'approval_required');
        emitPolicyDeny(actor, resource, 'approval_required');
        return {
          input,
          result: buildSafetyBlockedResult(
            `Tool '${name}' is destructive and requires approval, but no ApprovalHandler is registered`,
            'approval_required',
          ),
        };
      }
      throw new ConfigurationError(
        `Tool '${name}' requires approval but no ApprovalHandler is registered`,
      );
    }

    emitAuditEvent({
      type: 'approval.request',
      actor: { type: 'user', id: 'approver', name: 'approver' },
      action: 'request',
      resource,
      outcome: 'success',
      payload: { toolName: name, input },
    });

    const approval = await handler(
      buildApprovalRequest(name, input, {
        agentName: options?.agentName,
        stepNumber: options?.stepNumber,
        context: options?.context,
      }),
    );

    if (!approval.approved) {
      emitAuditEvent({
        type: 'approval.decide',
        actor: { type: 'user', id: 'approver', name: 'approver' },
        action: 'deny',
        resource,
        outcome: 'denied',
        payload: { reason: approval.reason },
      });
      emitToolDeny(actor, resource, 'approval_denied');
      emitPolicyDeny(actor, resource, 'approval_denied');
      return { input, result: buildToolApprovalDeniedResult(approval.reason) };
    }

    emitAuditEvent({
      type: 'approval.decide',
      actor: { type: 'user', id: 'approver', name: 'approver' },
      action: 'approve',
      resource,
      outcome: 'success',
    });

    return { input: resolveApprovedInput(input, approval) };
  }

  private async emitToolAudit(
    tool: BaseTool,
    input: Record<string, unknown>,
    result: ToolResult,
    agentName?: string,
  ): Promise<void> {
    const audit = normalizeToolMetadata(tool.metadata).audit;
    if (!audit || !this.auditHandler) {
      return;
    }

    const event: ToolAuditEvent = {
      timestamp: new Date().toISOString(),
      toolName: tool.name,
      agentName,
      success: result.success,
      input: applyAuditFilter(input, audit),
      output: result.success ? result.output : undefined,
      error: result.success ? undefined : result.error,
    };

    await this.auditHandler(event);
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

function toolAuditActor(agentName?: string) {
  return { type: 'agent' as const, id: agentName ?? 'unknown', name: agentName };
}

function emitToolAllow(actor: ReturnType<typeof toolAuditActor>, resource: string): void {
  emitAuditEvent({
    type: 'tool.allow',
    actor,
    action: 'allow',
    resource,
    outcome: 'success',
  });
}

function emitToolDeny(
  actor: ReturnType<typeof toolAuditActor>,
  resource: string,
  code: string,
): void {
  emitAuditEvent({
    type: 'tool.deny',
    actor,
    action: 'deny',
    resource,
    outcome: 'denied',
    payload: { code },
  });
}

function emitPolicyDeny(
  actor: ReturnType<typeof toolAuditActor>,
  resource: string,
  code: string,
): void {
  emitAuditEvent({
    type: 'policy.deny',
    actor,
    action: 'deny',
    resource,
    outcome: 'denied',
    payload: { code },
  });
}
