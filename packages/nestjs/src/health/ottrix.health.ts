import { Injectable } from '@nestjs/common';
import { ProviderRegistryService } from '../services/provider-registry.service.js';
import { ToolRegistryService } from '../services/tool-registry.service.js';

/** Health check result compatible with @nestjs/terminus. */
export interface OttrixHealthIndicatorResult {
  [key: string]: {
    status: 'up' | 'down';
    [meta: string]: unknown;
  };
}

/**
 * Ottrix health indicator for provider connectivity, circuit breakers, and MCP servers.
 *
 * Compatible with `@nestjs/terminus` when installed as an optional peer dependency.
 */
@Injectable()
export class OttrixHealthIndicator {
  constructor(
    private readonly providerRegistry: ProviderRegistryService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /** Run all Ottrix health checks. */
  async check(key = 'ottrix'): Promise<OttrixHealthIndicatorResult> {
    const providers = await this.providerRegistry.pingProviders();
    const mcp = await this.checkMcpConnections();

    const providerHealthy = Object.values(providers).every((entry) => entry.healthy);
    const mcpHealthy = Object.values(mcp).every((entry) => entry.connected);
    const isHealthy = providerHealthy && mcpHealthy;

    return {
      [key]: {
        status: isHealthy ? 'up' : 'down',
        providers,
        mcp,
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

  private async checkMcpConnections(): Promise<
    Record<string, { connected: boolean; state?: string }>
  > {
    const registry = this.toolRegistry.getMcpRegistry();
    const results: Record<string, { connected: boolean; state?: string }> = {};

    for (const name of registry.serverNames()) {
      const provider = registry.getProvider(name);
      if (!provider) {
        results[name] = { connected: false, state: 'missing' };
        continue;
      }
      const state = provider.getState();
      results[name] = {
        connected: state === 'connected',
        state,
      };
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
