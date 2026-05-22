import type { CompletionParams, CompletionProvider, CompletionResult, StreamChunk } from '../types/provider.js';
import type { AgentToolRegistry } from '../types/agent.js';
import type { ToolResult } from '../types/tools.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Telemetry } from './telemetry.js';

const INSTRUMENTED = Symbol.for('agentic-fabric.observability.instrumented');

/** Whether a provider was already wrapped by {@link instrumentProvider}. */
export function isInstrumentedProvider(provider: CompletionProvider): boolean {
  return (provider as { [INSTRUMENTED]?: boolean })[INSTRUMENTED] === true;
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as ToolResult).success === 'boolean'
  );
}

/** Options for instrumenting providers. */
export interface InstrumentOptions {
  component?: string;
}

/**
 * Wrap a {@link CompletionProvider} with LLM spans and metrics.
 */
export function instrumentProvider(
  provider: CompletionProvider,
  telemetry: Telemetry,
  options: InstrumentOptions = {},
): CompletionProvider {
  if (isInstrumentedProvider(provider)) {
    return provider;
  }

  const component = options.component ?? 'provider';

  const wrapped: CompletionProvider = {
    async complete(params: CompletionParams): Promise<CompletionResult> {
      const span = telemetry.startSpan('llm.complete', {
        component,
        'llm.model': params.model ?? 'default',
      });

      return telemetry.withActiveSpan(span, async () => {
        const started = performance.now();
        try {
          const result = await provider.complete(params);
          span
            .setAttribute('llm.model', result.model)
            .setAttribute('llm.input_tokens', result.usage.inputTokens)
            .setAttribute('llm.output_tokens', result.usage.outputTokens)
            .setAttribute('llm.total_tokens', result.usage.totalTokens)
            .setAttribute('llm.stop_reason', result.stopReason)
            .setStatus('ok');
          telemetry.counter('llm.calls', { component }).add(1);
          telemetry
            .histogram('llm.tokens', { component, kind: 'input' })
            .record(result.usage.inputTokens);
          telemetry
            .histogram('llm.tokens', { component, kind: 'output' })
            .record(result.usage.outputTokens);
          telemetry.histogram('llm.latency_ms', { component }).record(performance.now() - started);
          return result;
        } catch (error) {
          span.setStatus('error', error instanceof Error ? error.message : String(error));
          telemetry.counter('llm.errors', { component }).add(1);
          throw error;
        } finally {
          span.end();
        }
      });
    },

    stream(params: CompletionParams): AsyncIterable<StreamChunk> {
      return instrumentStream(provider, telemetry, params, component);
    },

    countTokens: (messages) => provider.countTokens(messages),
  };

  Object.defineProperty(wrapped, INSTRUMENTED, { value: true, enumerable: false });
  return wrapped;
}

async function* instrumentStream(
  provider: CompletionProvider,
  telemetry: Telemetry,
  params: CompletionParams,
  component: string,
): AsyncGenerator<StreamChunk> {
  const span = telemetry.startSpan('llm.stream', {
    component,
    'llm.model': params.model ?? 'default',
  });

  telemetry.enterActiveSpan(span);
  const started = performance.now();
  try {
    for await (const chunk of provider.stream(params)) {
      yield chunk;
      if (chunk.type === 'done' && chunk.data && typeof chunk.data === 'object') {
        const data = chunk.data as {
          usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
        };
        if (data.usage) {
          span
            .setAttribute('llm.input_tokens', data.usage.inputTokens)
            .setAttribute('llm.output_tokens', data.usage.outputTokens)
            .setAttribute('llm.total_tokens', data.usage.totalTokens);
        }
      }
    }
    span.setStatus('ok');
    telemetry.counter('llm.stream_calls', { component }).add(1);
    telemetry
      .histogram('llm.latency_ms', { component, mode: 'stream' })
      .record(performance.now() - started);
  } catch (error) {
    span.setStatus('error', error instanceof Error ? error.message : String(error));
    telemetry.counter('llm.errors', { component }).add(1);
    throw error;
  } finally {
    telemetry.leaveActiveSpan();
    span.end();
  }
}

/** Wrap a tool registry interface with execution spans. */
export function instrumentAgentToolRegistry(
  registry: AgentToolRegistry,
  telemetry: Telemetry,
  options: InstrumentOptions = {},
): AgentToolRegistry {
  if (registry instanceof ToolRegistry) {
    if (registry.usesTelemetry(telemetry)) {
      return registry;
    }
    return new ToolRegistry({
      onDuplicate: 'overwrite',
      telemetry,
      component: options.component ?? 'tools',
      cloneFrom: registry,
    });
  }

  const component = options.component ?? 'tools';
  return {
    list: () => registry.list(),
    execute: (name, input, options) =>
      runToolSpan(telemetry, component, name, () => registry.execute(name, input, options)),
  };
}

/** @internal Shared tool span runner. */
export async function runToolSpan<T>(
  telemetry: Telemetry,
  component: string,
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const span = telemetry.startSpan('tool.execute', {
    component,
    'tool.name': toolName,
  });

  return telemetry.withActiveSpan(span, async () => {
    const started = performance.now();
    try {
      const result = await fn();
      if (isToolResult(result)) {
        span
          .setAttribute('tool.success', result.success)
          .setStatus(result.success ? 'ok' : 'error', result.error);
      } else {
        span.setStatus('ok');
      }
      telemetry.counter('tool.executions', { component }).add(1);
      telemetry
        .histogram('tool.latency_ms', { component, 'tool.name': toolName })
        .record(performance.now() - started);
      return result;
    } catch (error) {
      span.setStatus('error', error instanceof Error ? error.message : String(error));
      telemetry.counter('tool.errors', { component }).add(1);
      throw error;
    } finally {
      span.end();
    }
  });
}
