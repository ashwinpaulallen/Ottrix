import { Logger } from './logger.js';
import { MetricsCollector } from './metrics.js';
import { Telemetry, type TelemetryRetentionOptions } from './telemetry.js';

let globalTelemetry: Telemetry | undefined;
let globalLogger: Logger | undefined;
let globalMetricsCollector: MetricsCollector | undefined;

/** Shared metrics collector (created lazily when unset). */
export function getMetricsCollector(): MetricsCollector {
  if (!globalMetricsCollector) {
    globalMetricsCollector = new MetricsCollector();
  }
  return globalMetricsCollector;
}

/** Replace the global metrics collector instance. */
export function setMetricsCollector(collector: MetricsCollector): void {
  globalMetricsCollector = collector;
  if (globalTelemetry) {
    globalTelemetry.linkMetricsCollector(collector);
  }
}

/** Shared telemetry instance (created lazily when unset). */
export function getTelemetry(): Telemetry {
  if (!globalTelemetry) {
    globalTelemetry = new Telemetry({ metricsCollector: getMetricsCollector() });
  }
  return globalTelemetry;
}

/** Replace the global telemetry instance. */
export function setTelemetry(telemetry: Telemetry): void {
  globalTelemetry = telemetry;
}

/** Shared root logger (created lazily when unset). */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ component: 'agent-kit' });
  }
  return globalLogger;
}

/** Replace the global logger instance. */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/** Apply in-memory retention limits to global telemetry and metrics. */
export function applyTelemetryRetention(options: TelemetryRetentionOptions): void {
  getTelemetry().setRetention(options);
  if (options.maxMetricsCollectorSamples !== undefined) {
    getMetricsCollector().setRetention(options.maxMetricsCollectorSamples);
  }
}

/** Flush trace exporters and reset global observability state. */
export async function shutdownObservability(): Promise<void> {
  if (globalTelemetry) {
    await globalTelemetry.shutdown();
  }
}

/** Reset global singletons (for tests). */
export function resetGlobalObservability(): void {
  globalTelemetry = undefined;
  globalLogger = undefined;
  globalMetricsCollector = undefined;
}
