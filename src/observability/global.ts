import { Logger } from './logger.js';
import { Telemetry } from './telemetry.js';

let globalTelemetry: Telemetry | undefined;
let globalLogger: Logger | undefined;

/** Shared telemetry instance (created lazily when unset). */
export function getTelemetry(): Telemetry {
  if (!globalTelemetry) {
    globalTelemetry = new Telemetry();
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
    globalLogger = new Logger({ component: 'agentic-fabric' });
  }
  return globalLogger;
}

/** Replace the global logger instance. */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}
