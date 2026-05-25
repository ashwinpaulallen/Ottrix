import type { ProviderRegistry } from '../providers/registry.js';
export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  providers: Record<
    string,
    {
      status: 'up' | 'down' | 'circuit_open';
      latencyMs?: number;
    }
  >;
  uptime: number;
  timestamp: string;
}

const PING_MESSAGE = [{ role: 'user' as const, content: 'ping' }];

/** Ping registered providers and summarize registry health. */
export async function checkHealth(registry: ProviderRegistry): Promise<HealthCheckResult> {
  const names = registry.listRegisteredProviders();
  const providers: HealthCheckResult['providers'] = {};

  await Promise.all(
    names.map(async (name) => {
      if (registry.isCircuitOpen(name)) {
        providers[name] = { status: 'circuit_open' };
        return;
      }

      const provider = registry.get(name);

      if (!registry.isHealthy(name)) {
        providers[name] = { status: 'down' };
        return;
      }

      const started = performance.now();
      try {
        await provider.countTokens(PING_MESSAGE);
        providers[name] = {
          status: 'up',
          latencyMs: Math.round(performance.now() - started),
        };
      } catch {
        providers[name] = {
          status: 'down',
          latencyMs: Math.round(performance.now() - started),
        };
      }
    }),
  );

  const statuses = Object.values(providers).map((entry) => entry.status);
  const upCount = statuses.filter((status) => status === 'up').length;
  const total = statuses.length;

  let status: HealthCheckResult['status'] = 'healthy';
  if (total === 0 || upCount === 0) {
    status = 'unhealthy';
  } else if (upCount < total) {
    status = 'degraded';
  }

  return {
    status,
    providers,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
