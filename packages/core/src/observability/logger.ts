/** Log severity levels (lowest to highest). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Structured log record emitted by {@link Logger}. */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/** Output sink for log entries. */
export type LogHandler = (entry: LogEntry) => void;

/** Logger configuration. */
export interface LoggerOptions {
  component?: string;
  context?: Record<string, unknown>;
  level?: LogLevel;
  silent?: boolean;
  pretty?: boolean;
  jsonLines?: boolean;
  handler?: LogHandler;
}

let globalLogLevel: LogLevel = 'info';

/** Configure the minimum level for all loggers without an explicit level. */
export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/** Read the current global minimum log level. */
export function getGlobalLogLevel(): LogLevel {
  return globalLogLevel;
}

/**
 * Structured logger with leveled output and child context inheritance.
 */
export class Logger {
  private readonly component: string;
  private readonly context: Record<string, unknown>;
  private readonly level: LogLevel;
  private readonly silent: boolean;
  private readonly pretty: boolean;
  private readonly jsonLines: boolean;
  private readonly handler: LogHandler;

  constructor(options: LoggerOptions = {}) {
    this.component = options.component ?? 'app';
    this.context = options.context ?? {};
    this.level = options.level ?? globalLogLevel;
    this.silent = options.silent ?? false;
    this.pretty = options.pretty ?? true;
    this.jsonLines = options.jsonLines ?? false;
    this.handler = options.handler ?? defaultLogHandler(this.pretty, this.jsonLines);
  }

  /** Create a child logger that inherits and extends context. */
  child(context: Record<string, unknown>): Logger {
    return new Logger({
      component: this.component,
      context: { ...this.context, ...context },
      level: this.level,
      silent: this.silent,
      pretty: this.pretty,
      jsonLines: this.jsonLines,
      handler: this.handler,
    });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.silent || LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(Object.keys(this.context).length > 0 ? { context: this.context } : {}),
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    this.handler(entry);
  }
}

function defaultLogHandler(pretty: boolean, jsonLines: boolean): LogHandler {
  return (entry) => {
    if (jsonLines) {
      console.log(safeJsonStringify(entry));
      return;
    }

    if (pretty) {
      const ctx =
        entry.context && Object.keys(entry.context).length > 0
          ? ` ${safeJsonStringify(entry.context)}`
          : '';
      const data =
        entry.data && Object.keys(entry.data).length > 0 ? ` ${safeJsonStringify(entry.data)}` : '';
      const line = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.component}${ctx}: ${entry.message}${data}`;
      if (entry.level === 'error') {
        console.error(line);
      } else if (entry.level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
      return;
    }

    console.log(safeJsonStringify(entry));
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable]';
  }
}
