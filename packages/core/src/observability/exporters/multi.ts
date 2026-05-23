import { logExporterError } from './shared.js';
import type { TraceData, TraceExporter } from './types.js';

/** Fans out traces to multiple {@link TraceExporter}s. */
export class MultiExporter implements TraceExporter {
  readonly name = 'multi';
  private readonly exporters: TraceExporter[];

  constructor(exporters: TraceExporter[]) {
    this.exporters = exporters;
  }

  async export(trace: TraceData): Promise<void> {
    await Promise.all(
      this.exporters.map(async (exporter) => {
        try {
          await exporter.export(trace);
        } catch (error) {
          logExporterError(exporter.name, 'Export failed', error);
        }
      }),
    );
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.shutdown()));
  }
}
