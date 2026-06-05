import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable } from 'rxjs';
import {
  Agent,
  FunctionTool,
  resetGlobalObservability,
  ToolNotFoundError,
} from 'ottrix';
import { OttrixModule } from '../src/ottrix.module.js';
import { OttrixTool } from '../src/decorators/ottrix-tool.decorator.js';
import { OttrixToolProvider } from '../src/tools/ottrix-tool.provider.js';
import { agentToken, OTTRIX_SESSION_MEMORY, OTTRIX_TOOL_REGISTRY } from '../src/tokens.js';
import { SessionMemoryService } from '../src/session/session-memory.js';
import { createChatPipeline } from '../src/helpers/chat-pipeline.js';
import type { ToolRegistry } from 'ottrix';

const TEST_OPTIONS = {
  providers: {
    anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
  },
  telemetry: { exporter: 'console' as const },
};

async function collectObservable<T>(observable: Observable<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    observable.subscribe({
      next: (value) => values.push(value),
      error: reject,
      complete: () => resolve(values),
    });
  });
}

describe('Ottrix improvements', () => {
  beforeEach(() => {
    resetGlobalObservability();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty forFeature configuration', () => {
    expect(() => OttrixModule.forFeature({ agents: [] })).toThrow(
      'OttrixModule.forFeature requires at least one of: agents, tools, or controller: true',
    );
  });

  it('@OttrixTool providers register on the global tool registry before agents resolve', async () => {
    @OttrixTool()
    @Injectable()
    class SearchProductsTool extends OttrixToolProvider {
      createTool() {
        return new FunctionTool({
          name: 'searchProducts',
          description: 'Search products',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          execute: async () => 'results',
        });
      }
    }

    const module = await Test.createTestingModule({
      imports: [
        OttrixModule.forRoot(TEST_OPTIONS),
        OttrixModule.forFeature({
          tools: [SearchProductsTool],
          agents: [
            {
              name: 'shop',
              systemPrompt: 'Shopping assistant',
              tools: ['searchProducts'],
            },
          ],
        }),
      ],
    }).compile();

    await module.init();

    const registry = module.get<ToolRegistry>(OTTRIX_TOOL_REGISTRY);
    expect(registry.get('searchProducts')).toBeDefined();
    expect(module.get<Agent>(agentToken('shop'))).toBeInstanceOf(Agent);
  });

  it('throws when agent references an unknown tool name', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          OttrixModule.forRoot(TEST_OPTIONS),
          OttrixModule.forFeature({
            agents: [{ name: 'shop', tools: ['missingTool'] }],
          }),
        ],
      }).compile(),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it('registers SessionMemoryService when sessionMemory is enabled', async () => {
    const module = await Test.createTestingModule({
      imports: [
        OttrixModule.forRoot({
          ...TEST_OPTIONS,
          sessionMemory: true,
        }),
      ],
    }).compile();

    await module.init();
    const service = module.get<SessionMemoryService>(OTTRIX_SESSION_MEMORY);
    expect(service).toBeInstanceOf(SessionMemoryService);
  });

  it('SessionMemoryService records turns per session', async () => {
    const service = new SessionMemoryService();
    await service.recordTurn('sess-1', 'Hello', 'Hi there');
    const memory = await service.getOrCreate('sess-1');
    expect(memory.getMessages()).toHaveLength(2);
  });

  it('createChatPipeline runs hooks and records session memory', async () => {
    const agent = {
      async *stream() {
        yield { type: 'text' as const, data: { text: 'Hello' } };
        yield {
          type: 'done' as const,
          data: {
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        };
      },
    } as unknown as Agent;

    const sessionMemory = new SessionMemoryService();
    const onRouted = vi.fn();
    const onComplete = vi.fn();

    const pipeline = createChatPipeline({
      resolveAgent: async () => agent,
      resolveIntent: async () => 'default',
      sessionMemory,
      hooks: { onRouted, onComplete },
    });

    await collectObservable(pipeline('Hi', 'sess-42'));

    expect(onRouted).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hi', sessionId: 'sess-42', intent: 'default' }),
    );
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello', sessionId: 'sess-42' }),
    );

    const memory = await sessionMemory.getOrCreate('sess-42');
    expect(memory.getMessages()).toHaveLength(2);
  });
});
