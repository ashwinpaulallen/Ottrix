/**
 * Verifies ESM and CJS subpath exports resolve after `npm run build`.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(join(root, 'package.json'));

/** Subpaths to smoke-test (including wildcard targets). */
const SUBPATHS = [
  '.',
  './types',
  './providers',
  './providers/anthropic',
  './providers/openai',
  './providers/ollama',
  './providers/base',
  './tools',
  './memory',
  './orchestration',
  './guardrails',
  './observability',
  './agent',
  './evals',
  './mcp-server',
  './exporters/langfuse',
  './exporters/braintrust',
  './exporters/webhook',
];

function resolveExport(subpath) {
  const key = subpath === '.' ? '.' : subpath;
  if (subpath.startsWith('./providers/') && subpath !== './providers') {
    const name = subpath.replace('./providers/', '');
    const pattern = pkg.exports['./providers/*'];
    return {
      import: pattern.import.replace('*', name),
      require: pattern.require.replace('*', name),
    };
  }
  if (subpath.startsWith('./exporters/')) {
    const name = subpath.replace('./exporters/', '');
    const pattern = pkg.exports['./exporters/*'];
    return {
      import: pattern.import.replace('*', name),
      require: pattern.require.replace('*', name),
    };
  }
  const entry = pkg.exports[key];
  if (!entry?.import) {
    throw new Error(`Missing export for ${subpath}`);
  }
  return entry;
}

let failed = 0;

for (const subpath of SUBPATHS) {
  const { import: esmRel, require: cjsRel } = resolveExport(subpath);
  const esmPath = join(root, esmRel);
  const cjsPath = join(root, cjsRel);

  if (!existsSync(esmPath)) {
    console.error(`✗ ${subpath} — missing ESM: ${esmRel}`);
    failed += 1;
    continue;
  }
  if (!existsSync(cjsPath)) {
    console.error(`✗ ${subpath} — missing CJS: ${cjsRel}`);
    failed += 1;
    continue;
  }

  try {
    await import(pathToFileURL(esmPath).href);
    require(cjsPath);
    console.log(`✓ ${subpath}`);
  } catch (error) {
    console.error(`✗ ${subpath}`, error);
    failed += 1;
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`\nAll ${SUBPATHS.length} subpath exports resolved (ESM + CJS).`);
}
