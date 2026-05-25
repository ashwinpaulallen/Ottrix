import { configureTraceExportFromConfig, getTelemetry, OtelExporter, type TraceExporter } from 'ottrix';
import type { OttrixTelemetryConfig } from '../interfaces.js';

/** Wire Ottrix telemetry exporters from NestJS module options. */
export function configureTelemetry(config?: OttrixTelemetryConfig): TraceExporter | undefined {
  if (!config || config.enabled === false) {
    return undefined;
  }

  if (config.exporter === 'otel') {
    if (!config.otel?.endpoint) {
      return undefined;
    }
    const exporter = new OtelExporter({
      endpoint: config.otel.endpoint,
      protocol: config.otel.protocol ?? 'http',
      headers: config.otel.headers,
      serviceName: config.otel.serviceName,
    });
    getTelemetry().addExporter(exporter);
    return exporter;
  }

  return configureTraceExportFromConfig({
    enabled: config.enabled ?? true,
    exporter: config.exporter,
    langfuse: config.langfuse,
    braintrust: config.braintrust,
    webhook: config.webhook,
    maxFinishedSpans: config.maxFinishedSpans,
    maxMetricPoints: config.maxMetricPoints,
    maxHistogramSamples: config.maxHistogramSamples,
    maxMetricsCollectorSamples: config.maxMetricsCollectorSamples,
  });
}
