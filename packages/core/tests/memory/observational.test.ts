import { describe, expect, it } from 'vitest';

import {
  InMemoryObservationStore,
  ObservationalMemory,
  keywordOverlap,
} from '../../src/memory/observational.js';
import type { ChatMessage } from '../../src/types/messages.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'I prefer Python over JavaScript for backend work.' },
  {
    role: 'assistant',
    content: 'Noted — I will favor Python examples when we discuss backend topics.',
  },
  { role: 'user', content: 'I am based in Chennai and prefer concise responses.' },
];

function extractionResponse(
  observations: Array<{
    category: 'preference' | 'fact' | 'behavior' | 'context' | 'instruction';
    content: string;
    confidence: number;
  }>,
): ReturnType<typeof textCompletion> {
  return textCompletion(JSON.stringify({ observations }));
}

function contradictionResponse(contradicts: boolean): ReturnType<typeof textCompletion> {
  return textCompletion(JSON.stringify({ contradicts }));
}

describe('ObservationalMemory extraction', () => {
  it('produces valid observations from a sample conversation', async () => {
    const provider = new MockCompletionProvider().enqueue(
      extractionResponse([
        {
          category: 'preference',
          content: 'User prefers Python over JavaScript',
          confidence: 0.9,
        },
        {
          category: 'context',
          content: 'User is based in Chennai',
          confidence: 0.85,
        },
      ]),
    );

    const memory = new ObservationalMemory({
      provider,
      store: new InMemoryObservationStore(),
    });

    const saved = await memory.extractFromMessages(SAMPLE_MESSAGES);
    expect(saved).toHaveLength(2);
    expect(saved.map((obs) => obs.content)).toContain('User prefers Python over JavaScript');
    expect(saved.every((obs) => obs.confidence > 0)).toBe(true);
  });
});

describe('ObservationalMemory deduplication', () => {
  it('updates an existing observation when the same fact is extracted again', async () => {
    const provider = new MockCompletionProvider()
      .enqueue(
        extractionResponse([
          {
            category: 'preference',
            content: 'User prefers Python over JavaScript',
            confidence: 0.8,
          },
        ]),
      )
      .enqueue(
        extractionResponse([
          {
            category: 'preference',
            content: 'User prefers Python over JavaScript for backend work',
            confidence: 0.95,
          },
        ]),
      )
      .enqueue(contradictionResponse(false));

    const store = new InMemoryObservationStore();
    const memory = new ObservationalMemory({ provider, store });

    await memory.extractFromMessages(SAMPLE_MESSAGES);
    await memory.extractFromMessages(SAMPLE_MESSAGES);

    const observations = await memory.getObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.generation).toBe(2);
    expect(observations[0]?.content).toContain('Python');
    expect(
      keywordOverlap(observations[0]!.content, 'User prefers Python over JavaScript'),
    ).toBeGreaterThan(0.6);
  });
});

describe('ObservationalMemory contradiction handling', () => {
  it('supersedes a conflicting preference with newer information', async () => {
    const store = new InMemoryObservationStore();
    const provider = new MockCompletionProvider()
      .enqueue(
        extractionResponse([
          {
            category: 'preference',
            content: 'User prefers Rust over Python',
            confidence: 0.9,
          },
        ]),
      )
      .enqueue(contradictionResponse(true));

    const memory = new ObservationalMemory({ provider, store });
    const previous = await memory.addExplicitObservation(
      'User prefers Python over JavaScript',
      'preference',
    );

    const saved = await memory.extractFromMessages([
      { role: 'user', content: 'Actually I prefer Rust over Python now.' },
    ]);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toContain('Rust');
    expect(saved[0]?.supersedes).toBe(previous.id);

    const remaining = await memory.getObservations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(previous.id);
  });
});

describe('ObservationalMemory context injection', () => {
  it('appends observations to the system prompt', async () => {
    const memory = new ObservationalMemory({
      provider: new MockCompletionProvider(),
      store: new InMemoryObservationStore(),
    });

    await memory.addExplicitObservation('User prefers concise responses', 'preference');
    await memory.addExplicitObservation('User is based in Chennai', 'context');

    const enriched = await memory.injectIntoContext('You are a helpful assistant.');
    expect(enriched).toContain('## Known information about this user:');
    expect(enriched).toContain('- User prefers concise responses');
    expect(enriched).toContain('- User is based in Chennai');
  });

  it('respects maxObservationsInContext', async () => {
    const memory = new ObservationalMemory({
      provider: new MockCompletionProvider(),
      store: new InMemoryObservationStore(),
      maxObservationsInContext: 3,
    });

    for (let index = 0; index < 5; index += 1) {
      await memory.addExplicitObservation(`Observation ${index}`, 'fact');
    }

    const enriched = await memory.injectIntoContext('Base prompt');
    const bulletCount = enriched.split('\n').filter((line) => line.startsWith('- ')).length;
    expect(bulletCount).toBe(3);
  });
});

describe('ObservationalMemory explicit observations', () => {
  it('stores explicit observations with confidence 1.0', async () => {
    const memory = new ObservationalMemory({
      provider: new MockCompletionProvider(),
      store: new InMemoryObservationStore(),
    });

    const observation = await memory.addExplicitObservation('User prefers dark mode', 'preference');
    expect(observation.confidence).toBe(1);
    expect(observation.source).toBe('explicit');
  });
});

describe('ObservationalMemory extraction interval', () => {
  it('skips auto extraction when configured as on_demand', () => {
    const memory = new ObservationalMemory({
      provider: new MockCompletionProvider(),
      store: new InMemoryObservationStore(),
      extractionInterval: 'on_demand',
    });

    memory.notifyRunCompleted();
    expect(memory.shouldAutoExtract()).toBe(false);
  });

  it('extracts every N turns when configured', () => {
    const memory = new ObservationalMemory({
      provider: new MockCompletionProvider(),
      store: new InMemoryObservationStore(),
      extractionInterval: 'every_n_turns',
      extractionN: 2,
    });

    memory.notifyRunCompleted();
    expect(memory.shouldAutoExtract()).toBe(false);
    memory.notifyRunCompleted();
    expect(memory.shouldAutoExtract()).toBe(true);
  });
});

describe('keywordOverlap', () => {
  it('returns high overlap for paraphrased facts', () => {
    expect(
      keywordOverlap(
        'User prefers Python over JavaScript',
        'User prefers Python over JavaScript for backend work',
      ),
    ).toBeGreaterThan(0.6);
  });
});
