import type { AgentResult, AgentStep } from '../types/agent.js';
import type { ChatMessage } from '../types/messages.js';
import type { SpanData } from './telemetry.js';

/** A single step in a recorded agent run. */
export interface RecordedRunStep {
  index: number;
  type: 'input' | 'llm' | 'tool' | 'output' | 'span';
  timestamp: number;
  label: string;
  data: Record<string, unknown>;
}

/** Serializable snapshot of a full agent run. */
export interface RecordedRun {
  id: string;
  agentName: string;
  input: string;
  response: string;
  stopReason?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  steps: AgentStep[];
  messages: ChatMessage[];
  spans: SpanData[];
  result?: AgentResult;
}

/** Options for {@link RunRecorder}. */
export interface RunRecorderOptions {
  agentName?: string;
}

/**
 * Records agent runs (spans, messages, tool calls) for debugging and replay.
 */
export class RunRecorder {
  private readonly agentName: string;
  private runs: RecordedRun[] = [];
  private current: Partial<RecordedRun> | null = null;

  constructor(options: RunRecorderOptions = {}) {
    this.agentName = options.agentName ?? 'agent';
  }

  /** Recorded runs. */
  getRuns(): readonly RecordedRun[] {
    return this.runs;
  }

  /** Latest recorded run, if any. */
  getLatestRun(): RecordedRun | undefined {
    return this.runs[this.runs.length - 1];
  }

  /** Whether a run is currently being recorded. */
  hasActiveRun(): boolean {
    return this.current !== null;
  }

  /** Discard the active run without saving it. */
  cancelRun(): void {
    this.current = null;
  }

  /** Begin recording a new run. */
  startRun(input: string, agentName?: string): void {
    if (this.current) {
      throw new Error('RunRecorder: startRun called while a run is already active');
    }
    this.current = {
      id: `run_${Date.now()}`,
      agentName: agentName ?? this.agentName,
      input,
      response: '',
      startedAt: new Date().toISOString(),
      steps: [],
      messages: [],
      spans: [],
    };
  }

  /** Append a conversation message. */
  recordMessage(message: ChatMessage): void {
    if (!this.current) {
      return;
    }
    this.current.messages = [...(this.current.messages ?? []), message];
  }

  /** Append an agent step. */
  recordAgentStep(step: AgentStep): void {
    if (!this.current) {
      return;
    }
    this.current.steps = [...(this.current.steps ?? []), step];
  }

  /** Append a finished span. */
  recordSpan(span: SpanData): void {
    if (!this.current) {
      return;
    }
    this.current.spans = [...(this.current.spans ?? []), span];
  }

  /** Finish the current run. */
  endRun(result: AgentResult): RecordedRun {
    if (!this.current) {
      throw new Error('RunRecorder: no active run to end');
    }

    const endedAt = new Date().toISOString();
    const startedAt = this.current.startedAt ?? endedAt;
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);

    const run: RecordedRun = {
      id: this.current.id ?? `run_${Date.now()}`,
      agentName: this.current.agentName ?? this.agentName,
      input: this.current.input ?? '',
      response: result.response,
      stopReason: result.metadata.stopReason,
      startedAt,
      endedAt,
      durationMs,
      steps: this.current.steps ?? [],
      messages: this.current.messages ?? [],
      spans: this.current.spans ?? [],
      result,
    };

    this.runs.push(run);
    this.current = null;
    return run;
  }

  /** Serialize all runs to JSON. */
  toJSON(pretty = false): string {
    return JSON.stringify(this.runs, null, pretty ? 2 : undefined);
  }

  /** Load runs from JSON produced by {@link RunRecorder.toJSON}. */
  static fromJSON(json: string): RunRecorder {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('RunRecorder.fromJSON: expected a JSON array of runs');
    }
    const recorder = new RunRecorder();
    recorder.runs = parsed as RecordedRun[];
    return recorder;
  }

  /**
   * Step through a recorded run for inspection.
   *
   * @param runId - Run id to replay; defaults to the latest run.
   */
  *replay(runId?: string): Generator<RecordedRunStep, void, void> {
    const run = runId ? this.runs.find((r) => r.id === runId) : this.getLatestRun();
    if (!run) {
      return;
    }

    const timeline = buildTimeline(run);
    for (const step of timeline) {
      yield step;
    }
  }

  clear(): void {
    this.runs = [];
    this.current = null;
  }
}

function buildTimeline(run: RecordedRun): RecordedRunStep[] {
  const steps: RecordedRunStep[] = [];

  steps.push({
    index: 0,
    type: 'input',
    timestamp: Date.parse(run.startedAt),
    label: 'user.input',
    data: { input: run.input },
  });

  for (const span of run.spans) {
    steps.push({
      index: 0,
      type: 'span',
      timestamp: span.startTime,
      label: span.name,
      data: {
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        durationMs: span.durationMs,
        attributes: span.attributes,
      },
    });
  }

  for (const step of run.steps) {
    steps.push({
      index: 0,
      type: step.type === 'tool_call' || step.type === 'tool_result' ? 'tool' : 'llm',
      timestamp: step.timestamp,
      label: `agent.${step.type}`,
      data: { content: step.content },
    });
  }

  steps.push({
    index: 0,
    type: 'output',
    timestamp: Date.parse(run.endedAt),
    label: 'agent.response',
    data: { response: run.response, stopReason: run.stopReason },
  });

  return steps
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((step, index) => ({ ...step, index }));
}
