import type { TraceData, TraceExporter } from './types.js';

/** Pretty-prints {@link TraceData} to the console. */
export class TraceConsoleExporter implements TraceExporter {
  readonly name = 'console';

  async export(trace: TraceData): Promise<void> {
    const duration = trace.endTime - trace.startTime;
    console.info(
      `[trace] ${trace.name} id=${trace.traceId.slice(0, 8)} ` +
        `status=${trace.status} duration=${duration}ms spans=${trace.spans.length}`,
    );

    for (const span of trace.spans) {
      const parent = span.parentSpanId ? ` parent=${span.parentSpanId.slice(0, 8)}` : '';
      const spanDuration = span.endTime - span.startTime;
      console.info(
        `  [span] ${span.name} id=${span.spanId.slice(0, 8)}${parent} duration=${spanDuration}ms`,
      );
    }
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** Stores exported traces in memory (for tests). */
export class InMemoryTraceExporter implements TraceExporter {
  readonly name = 'memory';
  readonly traces: TraceData[] = [];

  async export(trace: TraceData): Promise<void> {
    this.traces.push(trace);
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  clear(): void {
    this.traces.length = 0;
  }
}
