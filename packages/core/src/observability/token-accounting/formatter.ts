import type { TokenBreakdown } from './types.js';

/** Human-readable multiline summary of a run's token usage. */
export function formatTokenBreakdown(breakdown: TokenBreakdown): string {
  const lines: string[] = [];

  lines.push(`Token usage for run ${breakdown.runId}:`);
  lines.push(
    `  Total: ${breakdown.totalTokens.toLocaleString()} tokens ` +
      `(${breakdown.totalInputTokens.toLocaleString()} in, ${breakdown.totalOutputTokens.toLocaleString()} out)` +
      (breakdown.totalCostUsd !== undefined ? ` — $${breakdown.totalCostUsd.toFixed(4)}` : ''),
  );

  if (breakdown.totalCacheReadTokens > 0) {
    lines.push(
      `  Cache: ${breakdown.totalCacheReadTokens.toLocaleString()} reads, ` +
        `${breakdown.totalCacheWriteTokens.toLocaleString()} writes`,
    );
  }

  lines.push('  By capability:');

  const sorted = Object.entries(breakdown.byCapability).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );

  for (const [name, usage] of sorted) {
    const total = usage.inputTokens + usage.outputTokens;
    const cost = usage.costUsd !== undefined ? ` ($${usage.costUsd.toFixed(4)})` : '';
    const calls = usage.calls > 1 ? ` × ${usage.calls} calls` : '';
    lines.push(`    ${name}: ${total.toLocaleString()} tokens${calls}${cost}`);
  }

  return lines.join('\n');
}

/** Compact table format for logging. */
export function formatTokenBreakdownTable(breakdown: TokenBreakdown): string {
  const rows = Object.entries(breakdown.byCapability)
    .sort(([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .map(([name, usage]) => {
      const total = usage.inputTokens + usage.outputTokens;
      const cost = usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : '-';
      return `${name.padEnd(30)} ${String(total).padStart(8)} ${String(usage.calls).padStart(6)} ${cost.padStart(10)}`;
    });

  const header = `${'Capability'.padEnd(30)} ${'Tokens'.padStart(8)} ${'Calls'.padStart(6)} ${'Cost'.padStart(10)}`;
  const separator = '-'.repeat(58);

  return [header, separator, ...rows].join('\n');
}
