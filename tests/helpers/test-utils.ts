import { Agent } from '../../src/agent/agent.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentConfig, AgentEvent, AgentResult, AgentStopReason } from '../../src/types/agent.js';
import type { CompletionProvider } from '../../src/types/provider.js';
import type { BaseTool } from '../../src/tools/tool.js';
import { MockCompletionProvider } from './mock-provider.js';

export interface CreateTestAgentOptions {
  name?: string;
  provider: CompletionProvider;
  tools?: BaseTool[];
  toolRegistry?: ToolRegistry;
  systemPrompt?: string;
  maxSteps?: number;
  maxTokenBudget?: number;
  guardrailMiddleware?: AgentConfig['guardrailMiddleware'];
  guardrails?: AgentConfig['guardrails'];
  onStep?: AgentConfig['onStep'];
  onToolCall?: AgentConfig['onToolCall'];
  onError?: AgentConfig['onError'];
  telemetry?: AgentConfig['telemetry'];
}

/** Build an {@link Agent} with a {@link ToolRegistry} when tools are provided. */
export function createTestAgent(options: CreateTestAgentOptions): Agent {
  const { tools, toolRegistry: registryOption, provider, ...rest } = options;
  let toolRegistry = registryOption;

  if (tools?.length) {
    toolRegistry ??= new ToolRegistry();
    for (const tool of tools) {
      toolRegistry.register(tool);
    }
  }

  return new Agent({
    name: options.name ?? 'test-agent',
    provider,
    toolRegistry,
    ...rest,
  });
}

/** Create an agent backed by a queued {@link MockCompletionProvider}. */
export function createQueuedAgent(
  provider: MockCompletionProvider,
  options: Omit<CreateTestAgentOptions, 'provider'> = {},
): Agent {
  return createTestAgent({ ...options, provider });
}

/** Assert a successful completed run with optional response text. */
export function assertAgentCompleted(
  result: AgentResult,
  expectedResponse?: string,
): void {
  if (result.metadata.stopReason !== 'completed') {
    throw new Error(
      `Expected stopReason "completed", got "${result.metadata.stopReason}"` +
        (result.metadata.warning ? ` (${result.metadata.warning})` : ''),
    );
  }
  if (expectedResponse !== undefined && result.response !== expectedResponse) {
    throw new Error(`Expected response "${expectedResponse}", got "${result.response}"`);
  }
}

/** Assert the run stopped for a specific reason. */
export function assertStopReason(result: AgentResult, reason: AgentStopReason): void {
  if (result.metadata.stopReason !== reason) {
    throw new Error(`Expected stopReason "${reason}", got "${result.metadata.stopReason}"`);
  }
}

/** Collect all events from {@link Agent.stream}. */
export async function collectStreamEvents(
  agent: Agent,
  input: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.stream(input)) {
    events.push(event);
  }
  return events;
}

/** Drain a stream iterator until the first `done` event or `maxEvents`. */
export async function collectStreamUntilDone(
  agent: Agent,
  input: string,
  maxEvents = 50,
): Promise<{ events: AgentEvent[]; done?: AgentEvent }> {
  const events: AgentEvent[] = [];
  for await (const event of agent.stream(input)) {
    events.push(event);
    if (events.length >= maxEvents) {
      break;
    }
    if (event.type === 'done') {
      return { events, done: event };
    }
  }
  return { events, done: events.find((e) => e.type === 'done') };
}
