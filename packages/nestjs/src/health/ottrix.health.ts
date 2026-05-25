import { Inject, Injectable } from '@nestjs/common';
import type { ProviderRegistry } from 'ottrix';
import { checkHealth } from 'ottrix/http';
import { OTTRIX_PROVIDER_REGISTRY } from '../tokens.js';

/** Health check result compatible with @nestjs/terminus. */
export interface OttrixHealthIndicatorResult {
  [key: string]: {
    status: 'up' | 'down';
    [meta: string]: unknown;
  };
}

/**
 * Ottrix health indicator backed by {@link checkHealth} from `ottrix/http`.
 *
 * Compatible with `@nestjs/terminus` when installed as an optional peer dependency.
 */
@Injectable()
export class OttrixHealthIndicator {
  constructor(
    @Inject(OTTRIX_PROVIDER_REGISTRY) private readonly providerRegistry: ProviderRegistry,
  ) {}

  /** Run all Ottrix health checks. */
  async check(key = 'ottrix'): Promise<OttrixHealthIndicatorResult> {
    const result = await checkHealth(this.providerRegistry);

    return {
      [key]: {
        status: result.status === 'healthy' ? 'up' : 'down',
        check: result,
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
