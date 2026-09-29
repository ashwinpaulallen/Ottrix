/**
 * Publish all public Ottrix packages. Core first (adapters peer on ottrix).
 *
 * Usage (repo root, after `npm login`):
 *   npm run publish:all
 *   npm run publish:all -- --dry-run
 *
 * Extra flags after `--` are forwarded to `npm publish`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace names in publish order. */
const WORKSPACES = [
  'ottrix',
  '@ottrix/nestjs',
  '@ottrix/express',
  '@ottrix/fastify',
  '@ottrix/hono',
  '@ottrix/nextjs',
  '@ottrix/vercel-ai',
  '@ottrix/langchain',
  '@ottrix/mastra',
  '@ottrix/typesafe',
  '@ottrix/mcp-server',
  '@ottrix/exporter-otel',
  '@ottrix/exporter-langfuse',
  '@ottrix/exporter-braintrust',
];

const extra = process.argv.slice(2);

if (extra.includes('--help') || extra.includes('-h')) {
  console.log(`Publish all public Ottrix packages (core first).

Usage:
  npm run publish:all
  npm run publish:all -- --dry-run
  npm run publish:all -- --otp <code>

Do not pass --provenance unless publishing from GitHub Actions OIDC.
`);
  process.exit(0);
}

for (const workspace of WORKSPACES) {
  const args = ['publish', '-w', workspace, '--access', 'public', ...extra];
  console.log(`\n▶ npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ publish failed: ${workspace}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n✓ all packages published');
