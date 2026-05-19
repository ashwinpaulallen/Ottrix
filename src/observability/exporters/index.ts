import type { AgenticTelemetryConfig } from '../../config.js';
import {
  applyTelemetryRetention,
  getTelemetry,
} from '../global.js';
import { logExporterError } from './shared.js';
import { BraintrustExporter } from './braintrust.js';
import { TraceConsoleExporter, InMemoryTraceExporter } from './console.js';
import { LangfuseExporter } from './langfuse.js';
import type { TraceExporter } from './types.js';
import { WebhookExporter } from './webhook.js';

export type {
  TraceExporter,
  TraceData,
  SpanData,
} from './types.js';

export { buildTraceData } from './trace-builder.js';
export { LangfuseExporter, type LangfuseExporterOptions, type LangfuseBatchEvent } from './langfuse.js';
export { BraintrustExporter, type BraintrustExporterOptions } from './braintrust.js';
export { WebhookExporter, type WebhookExporterOptions } from './webhook.js';
export { TraceConsoleExporter, InMemoryTraceExporter } from './console.js';
export { MultiExporter } from './multi.js';

/** Create a {@link TraceExporter} from Ottrix telemetry configuration. */
export function createTraceExporterFromConfig(
  config: AgenticTelemetryConfig,
): TraceExporter | undefined {
  switch (config.exporter) {
    case 'none':
      return undefined;
    case 'console':
      return new TraceConsoleExporter();
    case 'memory':
      return new InMemoryTraceExporter();
    case 'langfuse': {
      const langfuse = config.langfuse;
      if (!langfuse?.publicKey || !langfuse.secretKey) {
        return undefined;
      }
      return new LangfuseExporter({
        publicKey: langfuse.publicKey,
        secretKey: langfuse.secretKey,
        baseUrl: langfuse.baseUrl,
      });
    }
    case 'braintrust': {
      const braintrust = config.braintrust;
      if (!braintrust?.apiKey || !braintrust.projectName) {
        return undefined;
      }
      return new BraintrustExporter({
        apiKey: braintrust.apiKey,
        projectName: braintrust.projectName,
        baseUrl: braintrust.baseUrl,
        projectId: braintrust.projectId,
      });
    }
    case 'webhook': {
      const webhook = config.webhook;
      if (!webhook?.url) {
        return undefined;
      }
      return new WebhookExporter({
        url: webhook.url,
        headers: webhook.headers,
      });
    }
    default:
      return undefined;
  }
}

/** Apply retention limits from telemetry configuration. */
export function applyTelemetryRetentionFromConfig(config: AgenticTelemetryConfig): void {
  if (
    config.maxFinishedSpans === undefined &&
    config.maxMetricPoints === undefined &&
    config.maxHistogramSamples === undefined &&
    config.maxMetricsCollectorSamples === undefined
  ) {
    return;
  }

  applyTelemetryRetention({
    maxFinishedSpans: config.maxFinishedSpans,
    maxMetricPoints: config.maxMetricPoints,
    maxHistogramSamples: config.maxHistogramSamples,
    maxMetricsCollectorSamples: config.maxMetricsCollectorSamples,
  });
}

/** Configure global telemetry trace export from config (no-op when disabled). */
export function configureTraceExportFromConfig(config: AgenticTelemetryConfig): TraceExporter | undefined {
  applyTelemetryRetentionFromConfig(config);

  if (!config.enabled) {
    return undefined;
  }

  const exporter = createTraceExporterFromConfig(config);
  if (exporter) {
    getTelemetry().setExporter(exporter);
  } else if (config.exporter !== 'none' && config.exporter !== 'memory') {
    logExporterError(
      'telemetry',
      `Exporter "${config.exporter}" is enabled but missing required configuration; traces will not be exported`,
    );
  }
  return exporter;
}
