import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/types/agent.js';
import {
  CancellableStreamProvider,
  MockProvider,
  delay,
  lightUsage,
  textCompletion,
  toolUseCompletion,
} from '../helpers/mock-provider.js';
import { echoTool } from '../helpers/mock-tools.js';
import {
  collectStreamEvents,
  createQueuedAgent,
  createTestAgent,
} from '../helpers/test-utils.js';

describe('integration: agent streaming', () => {
  it('streams text deltas and finishes with a done event', async () => {
    const provider = new MockProvider().enqueueStream(
      textCompletion('Streaming hello.', lightUsage),
    );

    const agent = createQueuedAgent(provider);
    const events = await collectStreamEvents(agent, 'Say hello');

    expect(events.some((e) => e.type === 'text')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();

    const data = done?.data as { response: string; stopReason: string };
    expect(data.response).toBe('Streaming hello.');
    expect(data.stopReason).toBe('completed');
  });

  it('streams tool_call and tool_result events between LLM turns', async () => {
    const provider = new MockProvider()
      .enqueueStream(
        toolUseCompletion([{ id: 'tu_1', name: 'echo', input: { message: 'ping' } }], lightUsage),
      )
      .enqueueStream(textCompletion('pong', lightUsage));

    const agent = createQueuedAgent(provider, { tools: [echoTool] });
    const types = (await collectStreamEvents(agent, 'echo ping')).map((e) => e.type);

    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');
  });

  it('allows early cancellation of the stream iterator', async () => {
    const doneResult = textCompletion('never finished', lightUsage);
    const provider = new CancellableStreamProvider(
      [
        { type: 'text_delta', data: { text: 'partial ' } },
        { type: 'text_delta', data: { text: 'response' } },
        { type: 'done', data: { stopReason: doneResult.stopReason, usage: doneResult.usage } },
      ],
      doneResult,
    );

    const agent = createTestAgent({ provider });
    const events: AgentEvent[] = [];

    const stream = agent.stream('Long stream');
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'text') {
        break;
      }
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(provider.streamStarted).toBe(true);
    expect(provider.streamClosed).toBe(true);
  });

  it('does not hang when stream provider yields slowly after first chunk', async () => {
    const doneResult = textCompletion('full', lightUsage);

    const slowProvider = {
      streamStarted: false,
      streamClosed: false,
      async complete() {
        return doneResult;
      },
      async *stream() {
        this.streamStarted = true;
        try {
          yield { type: 'text_delta' as const, data: { text: 'Hi' } };
          await delay(200);
          yield {
            type: 'done' as const,
            data: { stopReason: doneResult.stopReason, usage: doneResult.usage },
          };
        } finally {
          this.streamClosed = true;
        }
      },
      countTokens: async () => 1,
    };

    const agent = createTestAgent({ provider: slowProvider });
    const events: AgentEvent[] = [];

    for await (const event of agent.stream('test')) {
      events.push(event);
      if (event.type === 'text') {
        break;
      }
    }

    expect(slowProvider.streamClosed).toBe(true);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });
});
