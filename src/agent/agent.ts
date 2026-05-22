import { randomUUID } from 'node:crypto';
import { getRunContext, runGeneratorWith, runWith, withStep } from '../context/run-context.js';
import type {
  AgentConfig,
  AgentErrorAction,
  AgentEvent,
  AgentResult,
  AgentRunMetadata,
  AgentRunOptions,
  AgentStep,
  AgentStopReason,
  AgentToolRegistry,
} from '../types/agent.js';
import type { ZodTypeAny } from 'zod';
import { ZodError } from 'zod';
import type { z } from 'zod';
import type { ChatMessage, ContentBlock, ToolUseBlock } from '../types/messages.js';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  CompletionLatency,
  StreamChunk,
  TokenUsage,
} from '../types/provider.js';
import { ConfigurationError } from '../tools/errors.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  buildToolApprovalDenialMessage,
  getToolApprovalDenialReason,
  isToolApprovalDenied,
} from '../tools/tool-approval.js';
import { ContextManager } from './context.js';
import { PiiDetector, redactPii } from '../guardrails/validators.js';
import type { GuardrailBlockCode } from '../guardrails/types.js';
import { checkRunGuardrails, sumTokenUsage } from './guardrails.js';
import {
  buildAssistantMessage,
  buildToolResultBlock,
  buildToolResultsMessage,
  extractTextFromContent,
  extractToolUses,
  isTextOnlyResponse,
} from './messages.js';
import type { Plan, PlanStep, PlanValidationResult } from './planner.js';
import { instrumentProvider, instrumentAgentToolRegistry } from '../observability/instrument.js';
import { getMetricsCollector } from '../observability/global.js';
import { emitAuditEvent } from '../guardrails/audit.js';
import { ProviderRegistry } from '../providers/registry.js';
import { runInActiveSpanStack, Span, SpanStack, type Telemetry } from '../observability/telemetry.js';
import type { RunRecorder } from '../observability/replay.js';
import { OpenAIProvider } from '../providers/openai.js';
import { unknownCompletionLatency } from '../providers/latency.js';
import {
  StructuredOutputError,
  appendStructuredOutputToSystemPrompt,
  buildStructuredOutputRetryMessage,
  createStructuredOutputContext,
  parseAndValidateStructuredOutput,
  type StructuredOutputContext,
} from './structured-output.js';

const DEFAULT_MAX_STEPS = 10;
const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * Core ReAct (Reason + Act) agent.
 *
 * Drives a loop of LLM completions and tool executions until a final text
 * answer is produced or a guardrail / budget limit is hit.
 */
export class Agent {
  private readonly config: AgentConfig;
  private readonly provider: CompletionProvider;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly telemetry?: Telemetry;
  private readonly runRecorder?: RunRecorder;
  private readonly maxSteps: number;
  private readonly maxTokenBudget?: number;
  private readonly contextManager: ContextManager;

  /**
   * @param config - Agent identity, provider, tools, guardrails, and hooks.
   */
  constructor(config: AgentConfig) {
    this.config = config;
    this.telemetry = config.telemetry;
    this.runRecorder = config.runRecorder;
    this.provider = resolveProvider(config, this.telemetry);
    this.toolRegistry = resolveToolRegistry(config, this.telemetry);
    this.maxSteps = config.maxSteps ?? config.guardrails?.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxTokenBudget = config.maxTokenBudget ?? config.guardrails?.maxTokenBudget;
    this.contextManager = new ContextManager({
      provider: this.provider,
      systemPrompt: config.systemPrompt,
      contextLimitTokens: config.contextLimitTokens,
      keepRecentMessages: config.keepRecentMessages,
    });
  }

  /** Agent display name from configuration. */
  getName(): string {
    return this.config.name;
  }

  /** Optional reflector configured for this agent. */
  getReflector(): AgentConfig['reflector'] {
    return this.config.reflector;
  }

  /** Tool registry when a {@link ToolRegistry} instance was provided in config. */
  getToolRegistry(): ToolRegistry | undefined {
    return this.config.toolRegistry instanceof ToolRegistry
      ? this.config.toolRegistry
      : undefined;
  }

  /**
   * Run the agent to completion (non-streaming).
   */
  async run<TSchema extends ZodTypeAny = ZodTypeAny>(
    input: string,
    options?: AgentRunOptions<TSchema>,
  ): Promise<AgentResult<AgentRunMetadata, z.infer<TSchema>>> {
    return this.runInAgentContext(async () => {
      const telemetry = this.telemetry;
      if (!telemetry) {
        return this.runCore(input, options) as Promise<
          AgentResult<AgentRunMetadata, z.infer<TSchema>>
        >;
      }

      const rootSpan = telemetry.startSpan('agent.run', { 'agent.name': this.getName() });
      telemetry.gauge('agent.active_runs', { 'agent.name': this.getName() }).set(1);
      let result: AgentResult<AgentRunMetadata, z.infer<TSchema>> | undefined;

      try {
        const runResult = await telemetry.withActiveSpan(rootSpan, async () => {
          try {
            result = (await this.runCore(input, options, telemetry)) as AgentResult<
              AgentRunMetadata,
              z.infer<TSchema>
            >;
            return result;
          } catch (error) {
            rootSpan.setStatus('error', error instanceof Error ? error.message : String(error));
            telemetry.counter('agent.errors', { 'agent.name': this.getName() }).add(1);
            throw error;
          }
        });
        return runResult;
      } finally {
        this.annotateRootTrace(rootSpan, input, result?.response);
        rootSpan.end();
        telemetry.gauge('agent.active_runs', { 'agent.name': this.getName() }).set(0);
      }
    });
  }

  private runInAgentContext<T>(fn: () => Promise<T>): Promise<T> {
    const existing = getRunContext();
    return runWith(
      {
        ...existing,
        runId: (existing?.runId) ?? randomUUID(),
        agentName: this.getName(),
      },
      fn,
    );
  }

  private async runCore(
    input: string,
    options?: AgentRunOptions,
    telemetry?: Telemetry,
  ): Promise<AgentResult> {
    this.config.guardrailMiddleware?.reset();
    const spanStart = telemetry?.finishedSpans.length ?? 0;
    this.runRecorder?.startRun(input, this.getName());

    try {
      return await this.runCoreBody(input, options, telemetry, spanStart);
    } catch (error) {
      this.runRecorder?.cancelRun();
      throw error;
    }
  }

  private async runCoreBody(
    input: string,
    options: AgentRunOptions | undefined,
    telemetry: Telemetry | undefined,
    spanStart: number,
  ): Promise<AgentResult> {
    const runStarted = performance.now();
    const agentActor = { type: 'agent' as const, id: this.getName(), name: this.getName() };
    const agentResource = `agent:${this.getName()}`;

    emitAuditEvent({
      type: 'agent.run.start',
      actor: agentActor,
      action: 'run',
      resource: agentResource,
      outcome: 'success',
      payload: { inputLength: input.length },
    });

    const steps: AgentStep[] = [];
    let stopReason: AgentStopReason = 'completed';
    let runErrored = false;

    try {
    const outputSchema = options?.outputSchema ?? this.config.outputSchema;
    const structuredOutput = outputSchema
      ? createStructuredOutputContext(
          outputSchema,
          this.config.structuredOutputRetries ?? 3,
          this.supportsNativeJsonMode(),
        )
      : undefined;

    const prepared = await this.prepareRun(input);
    const messages = prepared.messages;
    for (const message of messages) {
      this.runRecorder?.recordMessage(message);
    }

    const usages: TokenUsage[] = [];
    let lastModel: string | undefined;
    let warning: string | undefined;
    let finalResponse = '';
    let parsedOutput: unknown;

    for (let iteration = 0; iteration < this.maxSteps; iteration++) {
      const loopControl = await runWith(withStep(`step_${iteration}`), async (): Promise<'break' | 'continue' | 'next'> => {
      await this.contextManager.maybeSummarize(messages);

      const providerCall = await this.callProvider(messages, structuredOutput);
      if (providerCall.blocked) {
        stopReason = providerCall.suspended ? 'guardrail' : mapGuardrailBlockCode(providerCall.code);
        warning = providerCall.suspended
          ? `${providerCall.reason ?? 'Budget approval required'}`
          : providerCall.reason;
        return 'break';
      }

      const completion = providerCall.result;
      usages.push(completion.usage);
      lastModel = completion.model;

      await this.recordStep(steps, {
        type: 'thinking',
        content: {
          content: completion.content,
          stopReason: completion.stopReason,
          model: completion.model,
        },
        tokenUsage: completion.usage,
      });

      messages.push(buildAssistantMessage(completion.content));

      if (isTextOnlyResponse(completion.content)) {
        finalResponse = await this.validateOutput(extractTextFromContent(completion.content));
        await this.recordStep(steps, {
          type: 'response',
          content: { text: finalResponse },
          tokenUsage: completion.usage,
        });

        if (this.config.reflector) {
          const reflectionStop = await this.applyReflection(
            steps,
            messages,
            input,
            true,
            prepared.plan,
          );
          if (reflectionStop) {
            stopReason = 'completed';
            return 'break';
          }
          return 'continue';
        }

        stopReason = 'completed';
        return 'break';
      }

      const toolUses = extractToolUses(completion.content);
      const toolOutcome = await this.executeToolCalls(toolUses, messages, steps);

      if (toolOutcome.stopReason) {
        stopReason = toolOutcome.stopReason;
        warning = toolOutcome.warning;
        finalResponse = toolOutcome.partialResponse ?? finalResponse;
        return 'break';
      }

      if (this.config.reflector) {
        const reflectionStop = await this.applyReflection(
          steps,
          messages,
          input,
          false,
          prepared.plan,
        );
        if (reflectionStop && (finalResponse || steps.some((s) => s.type === 'response'))) {
          stopReason = 'completed';
          finalResponse =
            finalResponse ||
            this.getLastResponseText(steps) ||
            extractTextFromContent(completion.content);
          return 'break';
        }
      }

      const totalTokens = sumTokenUsage(usages);
      const guard = checkRunGuardrails({
        stepIndex: iteration + 1,
        maxSteps: this.maxSteps,
        totalTokens,
        maxTokenBudget: this.maxTokenBudget,
        estimatedCostUsd: this.getEstimatedCostUsd(),
        guardrails: this.config.guardrails,
        lastStep: steps[steps.length - 1],
      });

      if (guard.shouldStop) {
        stopReason = toStopReason(guard.stopReason);
        warning = guard.message;
        finalResponse = extractTextFromContent(completion.content) || finalResponse;
        return 'break';
      }

      return 'next';
      });

      if (loopControl === 'break') {
        break;
      }
      if (loopControl === 'continue') {
        continue;
      }
    }

    if (!finalResponse && stopReason === 'completed') {
      finalResponse = this.findLastAssistantText(messages);
      if (!finalResponse) {
        stopReason = 'max_steps';
        warning =
          warning ??
          `Maximum steps (${this.maxSteps}) reached without a final text response`;
      }
    }

    const metadata: AgentRunMetadata = {
      stopReason,
      warning:
        warning ??
        (prepared.planValidation && !prepared.planValidation.valid
          ? `Plan validation: ${prepared.planValidation.errors.join('; ')}`
          : undefined),
      model: lastModel,
    };

    if (prepared.plan) {
      metadata.plan = prepared.plan;
    }
    if (prepared.planValidation) {
      metadata.planValidation = prepared.planValidation;
    }

    if (this.config.reflector) {
      metadata.resultEvaluation = await this.config.reflector.evaluateResult(
        {
          response: finalResponse,
          steps,
          totalTokens: sumTokenUsage(usages),
          metadata,
        },
        input,
      );
    }

    if (
      structuredOutput &&
      finalResponse &&
      this.shouldValidateStructuredOutput(stopReason)
    ) {
      const resolved = await this.finalizeStructuredOutput(
        messages,
        finalResponse,
        structuredOutput,
        usages,
        steps,
      );
      finalResponse = resolved.response;
      parsedOutput = resolved.parsedOutput;
    }

    const result: AgentResult = {
      response: finalResponse,
      parsedOutput,
      steps,
      totalTokens: sumTokenUsage(usages),
      metadata,
    };

    const runDuration = performance.now() - runStarted;
    const metrics = getMetricsCollector();
    metrics.record('agent_run_ms', runDuration, { agent: this.getName() });
    metrics.record('agent_steps_count', steps.length, { agent: this.getName() });

    this.scheduleObservationalExtraction(messages);
    this.syncRecorder(telemetry, result, spanStart);
    return result;
    } catch (error) {
      runErrored = true;
      stopReason = 'error';
      throw error;
    } finally {
      emitAuditEvent({
        type: 'agent.run.end',
        actor: agentActor,
        action: 'run',
        resource: agentResource,
        outcome: auditOutcomeForAgentRun(runErrored, stopReason),
        payload: { stopReason, stepCount: steps.length },
        duration: performance.now() - runStarted,
      });
    }
  }

  private annotateRootTrace(
    span: Span | undefined,
    input: string,
    output?: string,
  ): void {
    if (!span) {
      return;
    }
    span.setAttribute('trace.input', input);
    if (output !== undefined) {
      span.setAttribute('trace.output', output);
    }
  }

  private scheduleObservationalExtraction(messages: ChatMessage[]): void {
    const memory = this.config.observationalMemory;
    if (!memory) {
      return;
    }
    memory.notifyRunCompleted();
    if (!memory.shouldAutoExtract()) {
      return;
    }
    void memory.extractFromMessages(messages).catch(() => undefined);
  }

  private syncRecorder(
    telemetry: Telemetry | undefined,
    result: AgentResult,
    spanStart = 0,
  ): void {
    if (!this.runRecorder) {
      return;
    }

    for (const span of telemetry?.getFinishedSpansSince(spanStart) ?? []) {
      this.runRecorder.recordSpan(span);
    }

    this.runRecorder.endRun(result);
  }

  /**
   * Run the agent and yield real-time {@link AgentEvent}s.
   */
  async *stream(input: string): AsyncIterable<AgentEvent> {
    const existing = getRunContext();
    const ctx = {
      ...existing,
      runId: (existing?.runId) ?? randomUUID(),
      agentName: this.getName(),
    };

    yield* runGeneratorWith(ctx, async function* (this: Agent) {
      const telemetry = this.telemetry;
      if (!telemetry) {
        yield* this.streamCore(input);
        return;
      }

      const rootSpan = telemetry.startSpan('agent.stream', { 'agent.name': this.getName() });
      const spanStack = new SpanStack();
      spanStack.push(rootSpan);
      rootSpan.setAttribute('trace.input', input);
      telemetry.gauge('agent.active_runs', { 'agent.name': this.getName() }).set(1);
      let streamOutput: string | undefined;

      try {
        yield* runInActiveSpanStack(spanStack, async function* (this: Agent) {
          try {
            for await (const event of this.streamCore(input)) {
              if (event.type === 'done') {
                const doneData = event.data as { response?: string };
                streamOutput = doneData.response;
              }
              yield event;
            }
            rootSpan.setStatus('ok');
          } catch (error) {
            rootSpan.setStatus('error', error instanceof Error ? error.message : String(error));
            telemetry.counter('agent.errors', { 'agent.name': this.getName() }).add(1);
            throw error;
          }
        }.bind(this));
      } finally {
        if (streamOutput !== undefined) {
          rootSpan.setAttribute('trace.output', streamOutput);
        }
        rootSpan.end();
        spanStack.pop();
        telemetry.gauge('agent.active_runs', { 'agent.name': this.getName() }).set(0);
      }
    }.bind(this));
  }

  private async *streamCore(input: string): AsyncIterable<AgentEvent> {
    this.config.guardrailMiddleware?.reset();
    const spanStart = this.telemetry?.finishedSpans.length ?? 0;
    this.runRecorder?.startRun(input, this.getName());

    try {
      yield* this.streamCoreBody(input, spanStart);
    } catch (error) {
      this.runRecorder?.cancelRun();
      throw error;
    }
  }

  private async *streamCoreBody(
    input: string,
    spanStart: number,
  ): AsyncIterable<AgentEvent> {
    const runStarted = performance.now();
    const agentActor = { type: 'agent' as const, id: this.getName(), name: this.getName() };
    const agentResource = `agent:${this.getName()}`;
    let stopReason: AgentStopReason = 'completed';
    let runErrored = false;
    let stepCount = 0;

    emitAuditEvent({
      type: 'agent.run.start',
      actor: agentActor,
      action: 'stream',
      resource: agentResource,
      outcome: 'success',
      payload: { inputLength: input.length },
    });

    try {
    const prepared = await this.prepareRun(input);
    const messages = prepared.messages;
    const usages: TokenUsage[] = [];
    let warning: string | undefined;
    let finalResponse = '';

    yield { type: 'thinking', data: { status: 'started' } };

    for (let iteration = 0; iteration < this.maxSteps; iteration++) {
      const loopState = { break: false, abortStream: false };
      yield* runGeneratorWith(withStep(`step_${iteration}`), async function* (
        this: Agent,
      ): AsyncGenerator<AgentEvent, void, undefined> {
      await this.contextManager.maybeSummarize(messages);

      const streamCall = await this.streamProvider(messages, undefined);
      if ('blocked' in streamCall && streamCall.blocked) {
        stopReason = mapGuardrailBlockCode(streamCall.code);
        warning = streamCall.reason;
        loopState.break = true;
        return;
      }

      const { result, textParts, toolUses } = streamCall;

      for (const text of textParts) {
        yield { type: 'text', data: { text } };
      }

      if (result) {
        usages.push(result.usage);
        messages.push(buildAssistantMessage(result.content));

        if (isTextOnlyResponse(result.content)) {
          finalResponse = extractTextFromContent(result.content);
          stopReason = 'completed';
          loopState.break = true;
          return;
        }

        const streamedToolUses =
          toolUses.length > 0 ? toolUses : extractToolUses(result.content);

        for (const toolUse of streamedToolUses) {
          yield { type: 'tool_call', data: { name: toolUse.name, input: toolUse.input, id: toolUse.id } };

          const allowed = await this.invokeOnToolCall(toolUse.name, toolUse.input);
          if (!allowed) {
            stopReason = 'tool_blocked';
            warning = `Tool "${toolUse.name}" was blocked by onToolCall`;
            const block = buildToolResultBlock(toolUse.id, null, warning);
            messages.push(buildToolResultsMessage([block]));
            yield { type: 'tool_result', data: { id: toolUse.id, success: false, error: warning } };
            continue;
          }

          const guardrailBlock = await this.applyToolGuardrails(toolUse, []);
          if (guardrailBlock) {
            messages.push(buildToolResultsMessage([guardrailBlock.block]));
            yield {
              type: 'tool_result',
              data: { id: toolUse.id, name: toolUse.name, success: false, error: guardrailBlock.message },
            };
            continue;
          }

          const exec = await this.runToolWithErrorHandling(toolUse, []);
          if (isToolApprovalDenied(exec.result)) {
            const denialMessage = buildToolApprovalDenialMessage(exec.result!);
            const reason = getToolApprovalDenialReason(exec.result!);
            const block = buildToolResultBlock(toolUse.id, null, denialMessage);
            messages.push(buildToolResultsMessage([block]));
            const deniedEvent: AgentEvent = {
              type: 'tool_denied',
              data: { toolName: toolUse.name, reason },
            };
            this.emitAgentEvent(deniedEvent);
            yield deniedEvent;
            yield {
              type: 'tool_result',
              data: { id: toolUse.id, name: toolUse.name, success: false, error: denialMessage },
            };
            continue;
          }

          const block = buildToolResultBlock(
            toolUse.id,
            exec.result?.output ?? null,
            exec.result?.success === false ? exec.result.error : undefined,
          );
          messages.push(buildToolResultsMessage([block]));
          yield {
            type: 'tool_result',
            data: {
              id: toolUse.id,
              name: toolUse.name,
              success: exec.result?.success ?? false,
              output: exec.result?.output,
              error: exec.result?.error,
            },
          };

          if (exec.abort) {
            stopReason = 'aborted';
            warning = exec.error?.message;
            const aborted = this.buildStreamResult(finalResponse, stopReason, warning, usages);
            this.scheduleObservationalExtraction(messages);
            this.syncRecorder(this.telemetry, aborted, spanStart);
            loopState.abortStream = true;
            yield {
              type: 'done',
              data: {
                stopReason,
                warning,
                response: finalResponse,
                totalTokens: aborted.totalTokens,
              },
            };
            return;
          }
        }

        const totalTokens = sumTokenUsage(usages);
        const guard = checkRunGuardrails({
          stepIndex: iteration + 1,
          maxSteps: this.maxSteps,
          totalTokens,
          maxTokenBudget: this.maxTokenBudget,
          estimatedCostUsd: this.getEstimatedCostUsd(),
          guardrails: this.config.guardrails,
        });

        if (guard.shouldStop) {
          stopReason = toStopReason(guard.stopReason);
          warning = guard.message;
          loopState.break = true;
          return;
        }
      }
      }.bind(this));

      if (loopState.abortStream) {
        return;
      }
      if (loopState.break) {
        break;
      }
      stepCount += 1;
    }

    if (!finalResponse && stopReason === 'completed') {
      stopReason = 'max_steps';
      warning = `Maximum steps (${this.maxSteps}) reached`;
    }

    const result = this.buildStreamResult(finalResponse, stopReason, warning, usages);
    this.scheduleObservationalExtraction(messages);
    this.syncRecorder(this.telemetry, result, spanStart);

    yield {
      type: 'done',
      data: {
        stopReason,
        warning,
        response: finalResponse,
        totalTokens: result.totalTokens,
      },
    };
    } catch (error) {
      runErrored = true;
      stopReason = 'error';
      throw error;
    } finally {
      emitAuditEvent({
        type: 'agent.run.end',
        actor: agentActor,
        action: 'stream',
        resource: agentResource,
        outcome: auditOutcomeForAgentRun(runErrored, stopReason),
        payload: { stopReason, stepCount },
        duration: performance.now() - runStarted,
      });
    }
  }

  private buildStreamResult(
    response: string,
    stopReason: AgentStopReason,
    warning: string | undefined,
    usages: TokenUsage[],
  ): AgentResult {
    return {
      response,
      steps: [],
      totalTokens: sumTokenUsage(usages),
      metadata: { stopReason, warning },
    };
  }

  private async prepareRun(input: string): Promise<{
    messages: ChatMessage[];
    plan?: Plan;
    planValidation?: PlanValidationResult;
  }> {
    const messages: ChatMessage[] = [];
    let plan: Plan | undefined;
    let planValidation: PlanValidationResult | undefined;

    let systemPrompt = this.config.systemPrompt;
    if (this.config.observationalMemory) {
      systemPrompt = await this.config.observationalMemory.injectIntoContext(systemPrompt ?? '');
    }
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    let userContent = input;

    if (this.config.planner) {
      plan = await this.config.planner.plan(input);
      planValidation = this.config.planner.validate(plan);
      userContent = `${userContent}\n\n${this.config.planner.formatPlanForContext(plan)}`;
    }

    if (this.config.memory) {
      const entries = await this.config.memory.retrieve(input, { limit: 5 });
      if (entries.length > 0) {
        const memoryContext = entries.map((e) => `- ${e.content}`).join('\n');
        userContent = `Relevant memory:\n${memoryContext}\n\nUser request:\n${userContent}`;
      }
    }

    const validatedInput = await this.validateInput(userContent);
    messages.push({ role: 'user', content: validatedInput });
    return { messages, plan, planValidation };
  }

  private async validateInput(input: string): Promise<string> {
    return this.runValidators(this.config.guardrails?.inputValidators, input, 'Input');
  }

  private async validateOutput(output: string): Promise<string> {
    return this.runValidators(this.config.guardrails?.outputValidators, output, 'Output');
  }

  private async runValidators(
    validators: import('../types/guardrails.js').Validator[] | undefined,
    content: string,
    label: string,
  ): Promise<string> {
    if (!validators || validators.length === 0) {
      return content;
    }

    let current = content;
    for (const validator of validators) {
      const result = await validator.validate(current);
      if (!result.passed) {
        throw new Error(result.reason ?? `${label} blocked by ${validator.name}`);
      }
      if (validator instanceof PiiDetector && validator.redactsContent()) {
        current = redactPii(current);
      }
    }
    return current;
  }

  /**
   * Run reflection after an iteration. Returns true when the run should stop.
   */
  private async applyReflection(
    steps: AgentStep[],
    messages: ChatMessage[],
    goal: string,
    hadTextResponse: boolean,
    plan?: Plan,
  ): Promise<boolean> {
    const reflector = this.config.reflector;
    if (!reflector) {
      return false;
    }

    const lastStep = steps[steps.length - 1];
    if (lastStep) {
      const evaluation = await reflector.evaluateStep(lastStep, goal);
      if (evaluation.suggestion) {
        messages.push({
          role: 'user',
          content: `Reflection: ${evaluation.suggestion}`,
        });
      }

      const shouldReplan =
        !evaluation.onTrack &&
        this.config.planner &&
        (lastStep.type === 'tool_result' || lastStep.type === 'response');

      if (shouldReplan && this.config.planner) {
        const planner = this.config.planner;
        const completedSteps = this.getCompletedPlanSteps(plan, steps);
        const partialResults = steps
          .filter((s) => s.type === 'tool_result' || s.type === 'response')
          .map((s) => s.content);
        const revised = await planner.replan(goal, completedSteps, partialResults);
        messages.push({
          role: 'user',
          content: `Updated plan:\n${planner.formatPlanForContext(revised)}`,
        });
      }
    }

    const shouldContinue = await reflector.shouldContinue(steps, goal);
    if (!shouldContinue) {
      if (hadTextResponse || steps.some((s) => s.type === 'response')) {
        return true;
      }
      messages.push({
        role: 'user',
        content: 'Please provide your final answer to the user now.',
      });
      return false;
    }

    if (hadTextResponse) {
      messages.push({
        role: 'user',
        content: 'Continue refining your answer until the goal is fully met.',
      });
    }

    return false;
  }

  /**
   * Map agent progress to completed plan steps using real plan ids when available.
   */
  private getCompletedPlanSteps(plan: Plan | undefined, steps: AgentStep[]): PlanStep[] {
    if (plan) {
      const progress = steps.filter(
        (s) => s.type === 'tool_result' || s.type === 'response',
      ).length;
      return plan.steps.slice(0, Math.min(progress, plan.steps.length));
    }

    const completed: PlanStep[] = [];
    let index = 0;
    for (const step of steps) {
      if (step.type === 'tool_result' || step.type === 'response') {
        index += 1;
        completed.push({
          id: `step_${index}`,
          description: `Completed ${step.type}`,
          dependencies: index > 1 ? [`step_${index - 1}`] : [],
        });
      }
    }
    return completed;
  }

  private getLastResponseText(steps: AgentStep[]): string {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.type === 'response') {
        const content = step.content;
        if (typeof content === 'object' && content !== null && 'text' in content) {
          const record = content as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        }
      }
    }
    return '';
  }

  private async finalizeStructuredOutput(
    messages: ChatMessage[],
    initialText: string,
    ctx: StructuredOutputContext,
    usages: TokenUsage[],
    steps: AgentStep[],
  ): Promise<{ response: string; parsedOutput: unknown }> {
    let currentText = initialText;

    while (ctx.attempts < ctx.maxAttempts) {
      ctx.attempts += 1;
      const validation = parseAndValidateStructuredOutput(currentText, ctx.schema);
      if (validation.success) {
        return { response: currentText, parsedOutput: validation.data };
      }

      ctx.lastRawOutput = currentText;
      const zodError =
        validation.kind === 'zod'
          ? validation.error
          : new ZodError([
              {
                code: 'custom',
                path: [],
                message: validation.error.message,
              },
            ]);
      ctx.lastZodError = zodError;

      if (ctx.attempts >= ctx.maxAttempts) {
        throw new StructuredOutputError(
          'Structured output validation failed after maximum retries',
          currentText,
          zodError,
          ctx.attempts,
        );
      }

      messages.push({
        role: 'user',
        content: buildStructuredOutputRetryMessage(
          validation.kind === 'zod' ? validation.error : validation.error,
        ),
      });

      const providerCall = await this.callProvider(messages, ctx, { forceJsonMode: true });
      if (providerCall.blocked) {
        throw new StructuredOutputError(
          providerCall.reason,
          currentText,
          zodError,
          ctx.attempts,
        );
      }

      const completion = providerCall.result;
      usages.push(completion.usage);
      messages.push(buildAssistantMessage(completion.content));
      currentText = await this.validateOutput(extractTextFromContent(completion.content));

      await this.recordStep(steps, {
        type: 'response',
        content: { text: currentText, structuredRetry: true },
        tokenUsage: completion.usage,
      });
    }

    throw new StructuredOutputError(
      'Structured output validation failed after maximum retries',
      currentText,
      ctx.lastZodError ?? new ZodError([]),
      ctx.attempts,
    );
  }

  private shouldValidateStructuredOutput(stopReason: AgentStopReason): boolean {
    if (stopReason === 'aborted' || stopReason === 'error' || stopReason === 'guardrail') {
      return false;
    }
    if (stopReason === 'tool_blocked') {
      return false;
    }
    return true;
  }

  private supportsNativeJsonMode(): boolean {
    return this.config.provider instanceof OpenAIProvider;
  }

  private async callProvider(
    messages: ChatMessage[],
    structuredOutput?: StructuredOutputContext,
    structuredOptions?: { forceJsonMode?: boolean },
  ): Promise<
    | { blocked: true; reason: string; code?: GuardrailBlockCode; suspended?: boolean }
    | { blocked: false; result: CompletionResult }
  > {
    let params = this.buildCompletionParams(messages, structuredOutput, structuredOptions);
    let guardedMessages = messages;
    const middleware = this.config.guardrailMiddleware;

    if (middleware) {
      const pre = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: this.getName(),
        messages: guardedMessages,
        params,
      });

      if (!pre.proceed) {
        return {
          blocked: true,
          reason: pre.reason ?? 'LLM call blocked by guardrail',
          code: pre.code,
          suspended: pre.suspended,
        };
      }

      params = pre.context.params;
      guardedMessages = pre.context.messages;
    }

    const started = Date.now();
    let result = await this.provider.complete({
      ...params,
      messages: params.messages ?? guardedMessages,
    });

    if (middleware) {
      const post = await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: this.getName(),
        messages: guardedMessages,
        params,
        result,
        durationMs: Date.now() - started,
      });

      if (!post.proceed) {
        return {
          blocked: true,
          reason: post.reason ?? 'LLM response blocked by guardrail',
          code: post.code,
          suspended: post.suspended,
        };
      }

      result = post.result ?? post.context.result ?? result;
    }

    return { blocked: false, result };
  }

  private getEstimatedCostUsd(): number | undefined {
    const budget = this.config.guardrailMiddleware?.getBudgetGuardrail();
    return budget?.getUsageSnapshot().costUsd;
  }

  private buildCompletionParams(
    messages: ChatMessage[],
    structuredOutput?: StructuredOutputContext,
    structuredOptions?: { forceJsonMode?: boolean },
  ): CompletionParams {
    const tools = this.toolRegistry.list();
    const hasTools = tools.length > 0;

    let effectiveMessages = messages;
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    let systemPrompt =
      systemIndex >= 0
        ? extractTextFromContent(messages[systemIndex].content)
        : this.config.systemPrompt;
    let responseFormat: CompletionParams['responseFormat'] = 'text';

    if (structuredOutput) {
      systemPrompt = appendStructuredOutputToSystemPrompt(
        systemPrompt,
        structuredOutput.jsonSchema,
      );
      const enableJsonMode =
        structuredOutput.preferJsonResponseFormat &&
        (structuredOptions?.forceJsonMode === true || !hasTools);
      if (enableJsonMode) {
        responseFormat = 'json';
      }
    }

    if (systemIndex >= 0) {
      effectiveMessages = messages.map((message, index) =>
        index === systemIndex
          ? { role: 'system' as const, content: systemPrompt ?? '' }
          : message,
      );
      systemPrompt = undefined;
    }

    return {
      messages: effectiveMessages,
      tools: hasTools ? tools : undefined,
      systemPrompt,
      model: this.config.defaultModel,
      responseFormat,
    };
  }

  private async applyToolGuardrails(
    toolUse: ToolUseBlock,
    steps: AgentStep[],
  ): Promise<{ block: ReturnType<typeof buildToolResultBlock>; message: string } | null> {
    const middleware = this.config.guardrailMiddleware;
    if (!middleware) {
      return null;
    }

    const pendingStep: AgentStep = {
      type: 'tool_call',
      content: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      timestamp: Date.now(),
    };

    const pre = await middleware.beforeTool({
      phase: 'tool',
      timing: 'pre',
      agentName: this.getName(),
      toolName: toolUse.name,
      input: toolUse.input,
      pendingStep,
    });

    if (pre.proceed) {
      toolUse.input = pre.context.input;
      return null;
    }

    const message =
      pre.context.toolResultMessage ??
      pre.reason ??
      `Tool "${toolUse.name}" was blocked by guardrails`;

    void steps;
    return {
      block: buildToolResultBlock(toolUse.id, null, message),
      message,
    };
  }

  private async executeToolCalls(
    toolUses: ToolUseBlock[],
    messages: ChatMessage[],
    steps: AgentStep[],
  ): Promise<{
    stopReason?: AgentStopReason;
    warning?: string;
    partialResponse?: string;
  }> {
    const resultBlocks: ReturnType<typeof buildToolResultBlock>[] = [];

    for (const toolUse of toolUses) {
      await this.recordStep(steps, {
        type: 'tool_call',
        content: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      });

      const allowed = await this.invokeOnToolCall(toolUse.name, toolUse.input);
      if (!allowed) {
        const warning = `Tool "${toolUse.name}" was blocked by onToolCall`;
        const block = buildToolResultBlock(toolUse.id, null, warning);
        resultBlocks.push(block);
        await this.recordStep(steps, {
          type: 'tool_result',
          content: { id: toolUse.id, name: toolUse.name, success: false, error: warning },
        });
        return { stopReason: 'tool_blocked', warning };
      }

      const guardrailBlock = await this.applyToolGuardrails(toolUse, steps);
      if (guardrailBlock) {
        resultBlocks.push(guardrailBlock.block);
        await this.recordStep(steps, {
          type: 'tool_result',
          content: {
            id: toolUse.id,
            name: toolUse.name,
            success: false,
            error: guardrailBlock.message,
          },
        });
        continue;
      }

      const toolStarted = Date.now();
      const exec = await this.runToolWithErrorHandling(toolUse, steps);

      if (isToolApprovalDenied(exec.result)) {
        const denialMessage = buildToolApprovalDenialMessage(exec.result!);
        const reason = getToolApprovalDenialReason(exec.result!);
        const block = buildToolResultBlock(toolUse.id, null, denialMessage);
        resultBlocks.push(block);
        await this.recordStep(steps, {
          type: 'tool_result',
          content: {
            id: toolUse.id,
            name: toolUse.name,
            success: false,
            error: denialMessage,
          },
        });
        this.emitAgentEvent({
          type: 'tool_denied',
          data: { toolName: toolUse.name, reason },
        });
        continue;
      }

      let toolMessage =
        exec.result?.success === false ? exec.result.error : undefined;
      let toolOutput: unknown = exec.result?.output ?? null;

      if (this.config.guardrailMiddleware) {
        const post = await this.config.guardrailMiddleware.afterTool({
          phase: 'tool',
          timing: 'post',
          agentName: this.getName(),
          toolName: toolUse.name,
          input: toolUse.input,
          output: exec.result?.output,
          error: exec.result?.error,
          durationMs: Date.now() - toolStarted,
        });
        if (!post.proceed) {
          toolMessage = post.reason ?? 'Tool output blocked by guardrail';
          toolOutput = null;
        } else if (post.toolResultMessage) {
          toolMessage = post.toolResultMessage;
          toolOutput = post.toolResultMessage;
        }
      }

      const block = buildToolResultBlock(toolUse.id, toolOutput, toolMessage);
      resultBlocks.push(block);

      await this.recordStep(steps, {
        type: 'tool_result',
        content: {
          id: toolUse.id,
          name: toolUse.name,
          success: exec.result?.success ?? false,
          output: exec.result?.output,
          error: toolMessage ?? exec.result?.error,
        },
      });

      if (exec.abort) {
        return {
          stopReason: 'aborted',
          warning: exec.error?.message,
        };
      }
    }

    if (resultBlocks.length > 0) {
      messages.push(buildToolResultsMessage(resultBlocks));
    }

    return {};
  }

  private async runToolWithErrorHandling(
    toolUse: ToolUseBlock,
    steps?: AgentStep[],
  ): Promise<{
    result?: Awaited<ReturnType<AgentToolRegistry['execute']>>;
    abort?: boolean;
    error?: Error;
  }> {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const result = await this.toolRegistry.execute(toolUse.name, toolUse.input, {
          agentName: this.getName(),
          stepNumber: steps?.length ?? 0,
        });
        if (!result.success && !isToolApprovalDenied(result) && this.config.onError) {
          const step: AgentStep = {
            type: 'tool_result',
            content: { name: toolUse.name, error: result.error },
            timestamp: Date.now(),
          };
          const action = await this.config.onError(new Error(result.error ?? 'Tool failed'), step);
          const handled = this.handleErrorAction(action, toolUse, steps);
          if (handled.abort) return handled;
          if (handled.retry) continue;
          return { result };
        }
        return { result };
      } catch (error) {
        if (ConfigurationError.isConfigurationError(error)) {
          throw error;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        const step: AgentStep = {
          type: 'tool_result',
          content: { name: toolUse.name, error: err.message },
          timestamp: Date.now(),
        };
        const action = this.config.onError
          ? await this.config.onError(err, step)
          : undefined;
        const handled = this.handleErrorAction(action, toolUse, steps);
        if (handled.abort) return { abort: true, error: err };
        if (handled.retry) continue;
        return {
          result: { success: false, output: null, error: err.message },
          error: err,
        };
      }
    }

    return {
      result: { success: false, output: null, error: 'Tool failed after retries' },
    };
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.config.onAgentEvent?.(event);
  }

  private handleErrorAction(
    action: AgentErrorAction | void,
    toolUse: ToolUseBlock,
    steps?: AgentStep[],
  ): { retry?: boolean; abort?: boolean } {
    if (action === 'retry') return { retry: true };
    if (action === 'abort') return { abort: true };
    if (action === 'skip') {
      void toolUse;
      void steps;
      return {};
    }
    return {};
  }

  private async invokeOnToolCall(name: string, input: unknown): Promise<boolean> {
    if (!this.config.onToolCall) {
      return true;
    }
    const result = await this.config.onToolCall(name, input);
    return result !== false;
  }

  private async recordStep(
    steps: AgentStep[],
    partial: Omit<AgentStep, 'timestamp'>,
  ): Promise<AgentStep> {
    const step: AgentStep = { ...partial, timestamp: Date.now() };
    steps.push(step);
    await this.config.onStep?.(step);
    return step;
  }

  private findLastAssistantText(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'assistant') {
        return extractTextFromContent(msg.content);
      }
    }
    return '';
  }

  private async streamProvider(
    messages: ChatMessage[],
    structuredOutput?: StructuredOutputContext,
    structuredOptions?: { forceJsonMode?: boolean },
  ): Promise<
    | { blocked: true; reason: string; code?: GuardrailBlockCode; suspended?: boolean }
    | {
        blocked?: false;
        result: CompletionResult | null;
        textParts: string[];
        toolUses: ToolUseBlock[];
      }
  > {
    let params = this.buildCompletionParams(messages, structuredOutput, structuredOptions);
    let guardedMessages = messages;
    const middleware = this.config.guardrailMiddleware;

    if (middleware) {
      const pre = await middleware.beforeLlm({
        phase: 'llm',
        timing: 'pre',
        agentName: this.getName(),
        messages: guardedMessages,
        params,
      });

      if (!pre.proceed) {
        return {
          blocked: true,
          reason: pre.reason ?? 'LLM stream blocked by guardrail',
          code: pre.code,
          suspended: pre.suspended,
        };
      }

      params = pre.context.params;
      guardedMessages = pre.context.messages;
    }
    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    const toolInputs = new Map<string, { name: string; partial: string }>();

    let stopReason = 'end_turn';
    let usage: TokenUsage | undefined;
    let streamLatency = unknownCompletionLatency();
    let model = 'stream';
    const contentBlocks: ContentBlock[] = [];

    for await (const chunk of this.provider.stream({
      ...params,
      messages: params.messages ?? guardedMessages,
    })) {
      this.dispatchStreamChunk(chunk, {
        textParts,
        toolUses,
        toolInputs,
        contentBlocks,
        setMeta: (sr, u, m, latency) => {
          stopReason = sr;
          if (u) usage = u;
          if (m) model = m;
          if (latency) streamLatency = latency;
        },
      });
    }

    if (contentBlocks.length === 0 && textParts.length > 0) {
      contentBlocks.push({ type: 'text', text: textParts.join('') });
    }

    if (contentBlocks.length === 0 && toolUses.length === 0) {
      return { result: null, textParts, toolUses };
    }

    let result: CompletionResult = {
      content: contentBlocks,
      model,
      usage: usage ?? EMPTY_USAGE,
      stopReason,
      latency: streamLatency,
    };

    if (middleware) {
      const post = await middleware.afterLlm({
        phase: 'llm',
        timing: 'post',
        agentName: this.getName(),
        messages: guardedMessages,
        params,
        result,
      });

      if (!post.proceed) {
        return {
          blocked: true,
          reason: post.reason ?? 'LLM stream response blocked by guardrail',
          code: post.code,
          suspended: post.suspended,
        };
      }

      result = post.result ?? post.context.result ?? result;
    }

    return {
      result,
      textParts,
      toolUses,
    };
  }

  private dispatchStreamChunk(
    chunk: StreamChunk,
    ctx: {
      textParts: string[];
      toolUses: ToolUseBlock[];
      toolInputs: Map<string, { name: string; partial: string }>;
      contentBlocks: ContentBlock[];
      setMeta: (
        stopReason: string,
        usage?: TokenUsage,
        model?: string,
        latency?: CompletionLatency,
      ) => void;
    },
  ): void {
    switch (chunk.type) {
      case 'text_delta': {
        ctx.textParts.push(chunk.data.text);
        const textIndex = ctx.contentBlocks.findIndex((b) => b.type === 'text');
        if (textIndex >= 0) {
          const existing = ctx.contentBlocks[textIndex];
          if (existing?.type === 'text') {
            existing.text += chunk.data.text;
          }
        } else {
          ctx.contentBlocks.push({ type: 'text', text: chunk.data.text });
        }
        break;
      }
      case 'tool_use_start':
        ctx.toolInputs.set(chunk.data.id, { name: chunk.data.name, partial: '' });
        break;
      case 'tool_use_delta': {
        const entry = ctx.toolInputs.get(chunk.data.id);
        if (entry) {
          entry.partial += chunk.data.partialInput;
        }
        break;
      }
      case 'tool_use_end': {
        ctx.toolUses.push({
          type: 'tool_use',
          id: chunk.data.id,
          name: chunk.data.name,
          input: chunk.data.input,
        });
        ctx.contentBlocks.push({
          type: 'tool_use',
          id: chunk.data.id,
          name: chunk.data.name,
          input: chunk.data.input,
        });
        break;
      }
      case 'done':
        ctx.setMeta(
          chunk.data.stopReason,
          chunk.data.usage,
          undefined,
          chunk.data.latency,
        );
        break;
      default:
        break;
    }
  }
}

function auditOutcomeForAgentRun(
  runErrored: boolean,
  stopReason: AgentStopReason,
): 'success' | 'failure' | 'denied' {
  if (runErrored) {
    return 'failure';
  }
  if (stopReason === 'completed') {
    return 'success';
  }
  if (
    stopReason === 'guardrail' ||
    stopReason === 'token_budget' ||
    stopReason === 'cost_budget'
  ) {
    return 'denied';
  }
  return 'failure';
}

function toStopReason(reason?: string): AgentStopReason {
  return mapGuardrailBlockCode(reason as GuardrailBlockCode | undefined);
}

function mapGuardrailBlockCode(code?: GuardrailBlockCode): AgentStopReason {
  if (code === 'max_steps' || code === 'token_budget' || code === 'cost_budget') {
    return code;
  }
  return 'guardrail';
}

function resolveProvider(config: AgentConfig, telemetry?: Telemetry): CompletionProvider {
  if (!telemetry) {
    return config.provider;
  }

  if (config.provider instanceof ProviderRegistry) {
    return config.provider;
  }

  return instrumentProvider(config.provider, telemetry, { component: config.name });
}

function resolveToolRegistry(config: AgentConfig, telemetry?: Telemetry): AgentToolRegistry {
  if (config.toolRegistry) {
    if (telemetry) {
      if (
        config.toolRegistry instanceof ToolRegistry &&
        config.toolRegistry.usesTelemetry(telemetry)
      ) {
        return config.toolRegistry;
      }
      return instrumentAgentToolRegistry(config.toolRegistry, telemetry, {
        component: config.name,
      });
    }
    return config.toolRegistry;
  }
  const registry = new ToolRegistry({ telemetry, component: config.name });
  if (config.tools?.length) {
    for (const [index, executor] of config.tools.entries()) {
      registry.registerFromSchema(
        {
          name: `tool_${index}`,
          description: `Legacy tool #${index}`,
          inputSchema: { type: 'object', properties: {} },
        },
        (input) => executor.execute(input),
      );
    }
  }
  return registry;
}
