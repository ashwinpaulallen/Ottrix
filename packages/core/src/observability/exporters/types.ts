/** Serializable span within a {@link TraceData} export. */
export interface SpanData {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown>;
  }>;
}

/** Internal trace format exported to pluggable backends. */
export interface TraceData {
  traceId: string;
  name: string;
  startTime: number;
  endTime: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
  spans: SpanData[];
  metadata: Record<string, unknown>;
  input?: string;
  output?: string;
}

/** Pluggable trace exporter (Langfuse, Braintrust, webhook, etc.). */
export interface TraceExporter {
  name: string;
  export(trace: TraceData): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
