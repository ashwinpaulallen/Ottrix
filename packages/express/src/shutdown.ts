import type { Server } from 'node:http';

/** Options for {@link gracefulShutdown}. */
export interface GracefulShutdownOptions {
  /** Max time to wait for in-flight requests before force-closing (ms). @defaultValue 10000 */
  timeout?: number;
  /** Hook for flushing telemetry or other cleanup before the server closes. */
  onShutdown?: () => Promise<void>;
}

/** Gracefully shut down an HTTP server on SIGINT/SIGTERM. */
export function gracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): void {
  const timeoutMs = options.timeout ?? 10_000;
  let shuttingDown = false;

  const shutdown = (_signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    server.close(() => {
      void Promise.resolve(options.onShutdown?.()).then(() => {
        process.exit(0);
      });
    });

    setTimeout(() => {
      process.exit(1);
    }, timeoutMs).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
