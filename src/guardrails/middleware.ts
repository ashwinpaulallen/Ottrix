import { extractTextFromContent } from '../agent/messages.js';
import type { ContentBlock } from '../types/messages.js';
import type { CompletionResult } from '../types/provider.js';
import type { AuditLogger } from './audit.js';
import type { BudgetGuardrail } from './budget.js';
import type {
  GuardrailBlockCode,
  GuardrailDecision,
  GuardrailHandler,
  GuardrailPipelineResult,
  LlmGuardrailContext,
  StatefulGuardrailHandler,
  ToolGuardrailContext,
} from './types.js';

/** Applies an ordered chain of guardrail handlers around LLM and tool calls. */
export class GuardrailMiddleware {
  private readonly handlers: GuardrailHandler[];

  constructor(handlers: GuardrailHandler[] = []) {
    this.handlers = [...handlers];
  }

  /** Register a handler at the end of the chain. */
  use(handler: GuardrailHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Registered handlers in execution order. */
  listHandlers(): readonly GuardrailHandler[] {
    return this.handlers;
  }

  /** First {@link BudgetGuardrail} in the chain, if present. */
  getBudgetGuardrail(): BudgetGuardrail | undefined {
    return this.handlers.find((handler): handler is BudgetGuardrail => handler.name === 'budget');
  }

  /** First {@link AuditLogger} in the chain, if present. */
  getAuditLogger(): AuditLogger | undefined {
    return this.handlers.find((handler): handler is AuditLogger => handler.name === 'audit');
  }

  /** Reset stateful handlers (e.g. budget counters) before a new agent run. */
  reset(): void {
    for (const handler of this.handlers) {
      if (isStateful(handler)) {
        handler.reset();
      }
    }
  }

  /** Run pre-LLM hooks; returns whether the call may proceed. */
  async beforeLlm(context: LlmGuardrailContext): Promise<GuardrailPipelineResult<LlmGuardrailContext>> {
    return this.runLlmPipeline(context, (handler, ctx) => handler.beforeLlm?.(ctx));
  }

  /** Run post-LLM hooks; may modify the completion result text. */
  async afterLlm(
    context: LlmGuardrailContext,
  ): Promise<GuardrailPipelineResult<LlmGuardrailContext> & { result?: CompletionResult }> {
    const pipeline = await this.runLlmPipeline(context, (handler, ctx) => handler.afterLlm?.(ctx));
    return {
      ...pipeline,
      result: pipeline.context.result,
    };
  }

  /** Run pre-tool hooks. */
  async beforeTool(
    context: ToolGuardrailContext,
  ): Promise<GuardrailPipelineResult<ToolGuardrailContext>> {
    return this.runToolPipeline(context, (handler, ctx) => handler.beforeTool?.(ctx));
  }

  /** Run post-tool hooks. */
  async afterTool(
    context: ToolGuardrailContext,
  ): Promise<GuardrailPipelineResult<ToolGuardrailContext> & { toolResultMessage?: string }> {
    const pipeline = await this.runToolPipeline(context, (handler, ctx) => handler.afterTool?.(ctx));
    return {
      ...pipeline,
      toolResultMessage: pipeline.context.toolResultMessage,
    };
  }

  private async runLlmPipeline(
    initial: LlmGuardrailContext,
    invoke: (
      handler: GuardrailHandler,
      context: LlmGuardrailContext,
    ) => Promise<GuardrailDecision | void> | undefined,
  ): Promise<GuardrailPipelineResult<LlmGuardrailContext>> {
    let context = { ...initial };
    const flags: string[] = [];
    let proceed = true;
    let reason: string | undefined;
    let code: GuardrailBlockCode | undefined;

    for (const handler of this.handlers) {
      const decision = await invoke(handler, context);
      if (!decision) {
        continue;
      }

      await this.logDecision(handler.name, initial.agentName, decision);

      const outcome = applyDecision(decision, flags);
      proceed = outcome.proceed;
      reason = outcome.reason ?? reason;
      code = outcome.code ?? code;

      context = applyLlmModifications(context, decision);

      if (!proceed) {
        break;
      }
    }

    return { proceed, reason, code, flags, context };
  }

  private async runToolPipeline(
    initial: ToolGuardrailContext,
    invoke: (
      handler: GuardrailHandler,
      context: ToolGuardrailContext,
    ) => Promise<GuardrailDecision | void> | undefined,
  ): Promise<GuardrailPipelineResult<ToolGuardrailContext>> {
    let context = { ...initial };
    const flags: string[] = [];
    let proceed = true;
    let reason: string | undefined;
    let code: GuardrailBlockCode | undefined;

    for (const handler of this.handlers) {
      const decision = await invoke(handler, context);
      if (!decision) {
        continue;
      }

      await this.logDecision(handler.name, initial.agentName, decision);

      const outcome = applyDecision(decision, flags);
      proceed = outcome.proceed;
      reason = outcome.reason ?? reason;
      code = outcome.code ?? code;

      if (decision.toolInput) {
        context = { ...context, input: decision.toolInput };
      }
      if (decision.toolResultMessage) {
        context = { ...context, toolResultMessage: decision.toolResultMessage };
      }

      if (!proceed) {
        break;
      }
    }

    return { proceed, reason, code, flags, context };
  }

  private async logDecision(
    handlerName: string,
    agentName: string,
    decision: GuardrailDecision,
  ): Promise<void> {
    if (decision.action === 'allow' && !decision.flags?.length) {
      return;
    }

    const audit = this.getAuditLogger();
    if (audit) {
      await audit.logDecision(agentName, handlerName, decision);
    }
  }
}

function applyDecision(
  decision: GuardrailDecision,
  flags: string[],
): { proceed: boolean; reason?: string; code?: GuardrailBlockCode } {
  if (decision.flags) {
    flags.push(...decision.flags);
  }

  if (decision.action === 'block') {
    return {
      proceed: false,
      reason: decision.reason ?? 'Blocked by guardrail',
      code: decision.code ?? 'guardrail',
    };
  }

  if (decision.action === 'flag') {
    if (decision.reason) {
      flags.push(decision.reason);
    }
    return { proceed: true };
  }

  return { proceed: true, reason: decision.reason };
}

function applyLlmModifications(
  context: LlmGuardrailContext,
  decision: GuardrailDecision,
): LlmGuardrailContext {
  let next = context;

  if (decision.params) {
    next = { ...next, params: decision.params };
  }
  if (decision.messages) {
    next = { ...next, messages: decision.messages };
  }
  if (decision.modifiedText && next.result) {
    next = {
      ...next,
      result: replaceCompletionText(next.result, decision.modifiedText),
    };
  }

  return next;
}

function replaceCompletionText(result: CompletionResult, text: string): CompletionResult {
  const content: ContentBlock[] = [{ type: 'text', text }];
  return { ...result, content };
}

function isStateful(handler: GuardrailHandler): handler is StatefulGuardrailHandler {
  return 'reset' in handler && typeof handler.reset === 'function';
}

/** Extract text from a completion for validators. */
export function completionText(result: CompletionResult): string {
  return extractTextFromContent(result.content);
}
