import { logExporterError, sleep } from './shared.js';
import type { TraceData, TraceExporter } from './types.js';

/** Options for {@link WebhookExporter}. */
export interface WebhookExporterOptions {
  url: string;
  headers?: Record<string, string>;
  batchSize?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

/** POSTs {@link TraceData} batches to a webhook URL. */
export class WebhookExporter implements TraceExporter {
  readonly name = 'webhook';

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly buffer: TraceData[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private flushing = false;

  constructor(options: WebhookExporterOptions) {
    this.url = options.url;
    this.headers = {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    };
    this.batchSize = options.batchSize ?? 10;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;

    const flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async export(trace: TraceData): Promise<void> {
    if (this.closed) {
      return;
    }

    this.buffer.push(trace);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    const payload = this.buffer.splice(0, this.buffer.length);
    try {
      const delivered = await this.postWithRetry(payload);
      if (!delivered) {
        this.buffer.unshift(...payload);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private async postWithRetry(payload: TraceData[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          return true;
        }

        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          logExporterError(this.name, `Webhook rejected payload with status ${response.status}`);
          return true;
        }

        if (attempt >= this.maxRetries) {
          logExporterError(
            this.name,
            `Webhook delivery failed with status ${response.status} after retries`,
          );
          return false;
        }
      } catch (error) {
        if (attempt >= this.maxRetries) {
          logExporterError(this.name, 'Webhook delivery failed after retries', error);
          return false;
        }
      }

      if (attempt < this.maxRetries) {
        await sleep(this.initialBackoffMs * 2 ** attempt);
      }
    }

    return false;
  }
}
