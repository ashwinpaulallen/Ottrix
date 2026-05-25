import { Inject, Injectable } from '@nestjs/common';
import { BaseProvider, type ProviderRegistry } from 'ottrix';
import { OTTRIX_PROVIDER_NAMES, OTTRIX_PROVIDER_REGISTRY } from '../tokens.js';

/** Health check result compatible with @nestjs/terminus. */
export interface OttrixHealthIndicatorResult {
  [key: string]: {
    status: 'up' | 'down';
    [meta: string]: unknown;
  };
}

/**
 * Ottrix health indicator for provider connectivity and circuit breaker state.
 *
 * Compatible with `@nestjs/terminus` when installed as an optional peer dependency.
 */
@Injectable()
export class OttrixHealthIndicator {
  constructor(
    @Inject(OTTRIX_PROVIDER_REGISTRY) private readonly providerRegistry: ProviderRegistry,
    @Inject(OTTRIX_PROVIDER_NAMES) private readonly providerNames: string[],
  ) {}

  /** Run all Ottrix health checks. */
  async check(key = 'ottrix'): Promise<OttrixHealthIndicatorResult> {
    const providers = await this.pingProviders();
    const isHealthy = Object.values(providers).every((entry) => entry.healthy);

    return {
      [key]: {
        status: isHealthy ? 'up' : 'down',
        providers,
      },
    };
  }

  /** Terminus-style helper that throws when unhealthy. */
  async isHealthy(key = 'ottrix'): Promise<OttrixHealthIndicatorResult> {
    const result = await this.check(key);
    if (result[key]?.status === 'down') {
      throw new OttrixHealthCheckError('Ottrix health check failed', result);
    }
    return result;
  }

  private async pingProviders(): Promise<
    Record<string, { healthy: boolean; circuitState?: string; detail?: string }>
  > {
    const results: Record<string, { healthy: boolean; circuitState?: string; detail?: string }> =
      {};

    for (const name of this.providerNames) {
      try {
        const provider = this.providerRegistry.get(name);
        let healthy = this.providerRegistry.isHealthy(name);
        let detail: string | undefined;

        if ('healthCheck' in provider && typeof provider.healthCheck === 'function') {
          const status = await (
            provider as { healthCheck: () => Promise<{ ok?: boolean; status?: string }> }
          ).healthCheck();
          healthy = status.ok !== false;
          detail = status.status;
          this.providerRegistry.setHealthy(name, healthy);
        }

        const circuitState =
          provider instanceof BaseProvider ? provider.getCircuitState() : undefined;

        results[name] = { healthy, circuitState, detail };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[name] = { healthy: false, detail: message };
        try {
          this.providerRegistry.setHealthy(name, false);
        } catch {
          // Provider may have been removed.
        }
      }
    }

    return results;
  }
}

/** Thrown by {@link OttrixHealthIndicator.isHealthy} when checks fail. */
export class OttrixHealthCheckError extends Error {
  constructor(
    message: string,
    readonly causes: OttrixHealthIndicatorResult,
  ) {
    super(message);
    this.name = 'OttrixHealthCheckError';
  }
}
