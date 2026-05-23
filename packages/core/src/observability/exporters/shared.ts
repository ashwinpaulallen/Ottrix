import { randomUUID } from 'node:crypto';

/** Sleep for the given duration. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a unique event identifier. */
export function createEventId(): string {
  return randomUUID();
}

/** Convert epoch milliseconds to ISO-8601. */
export function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** Safely log exporter failures without throwing. */
export function logExporterError(exporter: string, message: string, error?: unknown): void {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error === undefined || error === null
          ? ''
          : JSON.stringify(error);
  console.warn(`[${exporter}] ${message}${detail ? `: ${detail}` : ''}`);
}

/** Fetch wrapper that never throws — returns response or undefined. */
export async function safeFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | undefined> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    logExporterError('fetch', `Network error for ${url}`, error);
    return undefined;
  }
}
