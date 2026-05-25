import type { Agent } from '../agent/agent.js';
import { getRunContext, type RunContext } from '../context/run-context.js';
import type { AgentEvent, AgentResult, AgentRunMetadata } from '../types/agent.js';
import { BaseProvider, type BaseProviderConfig } from '../providers/base.js';
import type { ChatMessage } from '../types/messages.js';
import type { CompletionResult, StreamChunk } from '../types/provider.js';
import { CircuitOpenError } from '../providers/circuit-breaker.js';
import { ProviderError, type ProviderErrorCode } from '../providers/errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ensureCompletionLatency } from '../providers/latency.js';

const DEFAULT_TOTAL_TOKENS = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

const DEFAULT_RESULT: AgentResult<AgentRunMetadata> = {
  response: 'Hello world',
  steps: [],
  totalTokens: DEFAULT_TOTAL_TOKENS,
  metadata: { stopReason: 'completed' },
};

const DEFAULT_STREAM_EVENTS: AgentEvent[] = [
  { type: 'text', data: { text: 'Hello ' } },
  { type: 'text', data: { text: 'world' } },
  {
    type: 'done',
    data: {
      stopReason: 'completed',
      response: 'Hello world',
      totalTokens: DEFAULT_TOTAL_TOKENS,
    },
  },
];

/** Mock agent with RunContext introspection for contract tests. */
export type MockAgentHandle = Agent & {
  getLastRunContext(): RunContext | undefined;
};

/** Options for {@link createMockAgent}. */
export interface CreateMockAgentOptions {
  runResponse?: Partial<AgentResult<AgentRunMetadata>>;
  streamEvents?: AgentEvent[];
  /** Delay between streamed events (ms) — useful for keepalive contract tests. */
  streamDelayMs?: number;
  error?: Error;
}

class MockAgentImpl {
  private lastRunContext: RunContext | undefined;
  private readonly runResponse: AgentResult<AgentRunMetadata>;
  private readonly streamEvents: AgentEvent[];
  private readonly streamDelayMs: number;
  private readonly error?: Error;

  constructor(options: CreateMockAgentOptions = {}) {
    this.runResponse = {
      ...DEFAULT_RESULT,
      ...options.runResponse,
      totalTokens: options.runResponse?.totalTokens ?? DEFAULT_TOTAL_TOKENS,
      metadata: {
        ...DEFAULT_RESULT.metadata,
        ...options.runResponse?.metadata,
      },
    };
    this.streamEvents = options.streamEvents ?? DEFAULT_STREAM_EVENTS;
    this.streamDelayMs = options.streamDelayMs ?? 0;
    this.error = options.error;
  }

  getName(): string {
    return 'mock-agent';
  }

  getLastRunContext(): RunContext | undefined {
    return this.lastRunContext;
  }

  run(_input: string): Promise<AgentResult<AgentRunMetadata>> {
    this.captureContext();
    if (this.error) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.runResponse);
  }

  async *stream(_input: string): AsyncIterable<AgentEvent> {
    this.captureContext();
    if (this.error) {
      throw this.error;
    }

    for (const event of this.streamEvents) {
      if (this.streamDelayMs > 0) {
        await sleep(this.streamDelayMs);
      }
      yield event;
    }
  }

  private captureContext(): void {
    this.lastRunContext = getRunContext();
  }
}

/** Create a mock {@link Agent} for adapter contract tests. */
export function createMockAgent(options?: CreateMockAgentOptions): MockAgentHandle {
  return new MockAgentImpl(options) as unknown as MockAgentHandle;
}

class HealthyMockProvider extends BaseProvider {
  constructor(config: BaseProviderConfig) {
    super(config);
  }

  protected _rawComplete(): Promise<CompletionResult> {
    return Promise.resolve(
      ensureCompletionLatency({
        content: [{ type: 'text', text: 'ok' }],
        model: this.config.defaultModel,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'stop',
      }),
    );
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      await Promise.resolve();
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected _countTokens(_messages: ChatMessage[]): Promise<number> {
    return Promise.resolve(1);
  }
}

class DownMockProvider extends BaseProvider {
  constructor(config: BaseProviderConfig) {
    super(config);
  }

  protected _rawComplete(): Promise<CompletionResult> {
    return Promise.resolve(
      ensureCompletionLatency({
        content: [{ type: 'text', text: 'ok' }],
        model: this.config.defaultModel,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'stop',
      }),
    );
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      await Promise.resolve();
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected _countTokens(_messages: ChatMessage[]): Promise<number> {
    return Promise.reject(
      new ProviderError('provider down', { code: 'server_error', retryable: true }),
    );
  }
}

class CircuitOpenMockProvider extends HealthyMockProvider {
  override isCircuitOpen(): boolean {
    return true;
  }
}

/** Options for {@link createMockProviderRegistry}. */
export interface CreateMockProviderRegistryOptions {
  providers?: Record<string, 'healthy' | 'down' | 'circuit_open'>;
}

/** Create a mock {@link ProviderRegistry} for health check contract tests. */
export function createMockProviderRegistry(
  options: CreateMockProviderRegistryOptions = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const providers = options.providers ?? { default: 'healthy' };

  for (const [name, state] of Object.entries(providers)) {
    const model = `${name}-model`;
    switch (state) {
      case 'circuit_open':
        registry.register(name, new CircuitOpenMockProvider({ defaultModel: model }));
        break;
      case 'down':
        registry.register(name, new DownMockProvider({ defaultModel: model }));
        registry.setHealthy(name, false);
        break;
      case 'healthy':
      default:
        registry.register(name, new HealthyMockProvider({ defaultModel: model }));
        break;
    }
  }

  return registry;
}

/** Convenience helper for typed {@link ProviderError} instances in contract tests. */
export function createProviderError(
  code: string,
  _options?: { retryAfterMs?: number },
): ProviderError {
  const normalized = code as ProviderErrorCode;
  return new ProviderError(`mock provider error (${normalized})`, {
    code: normalized,
    retryable: normalized === 'rate_limit' || normalized === 'server_error' || normalized === 'timeout',
  });
}

/** Convenience helper for {@link CircuitOpenError} in contract tests. */
export function createCircuitOpenError(retryAfterMs = 30_000): CircuitOpenError {
  return new CircuitOpenError('mock circuit open', 'mock-provider', retryAfterMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
