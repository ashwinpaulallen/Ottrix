#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const vitestArgs = ['run'];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--testPathPattern') {
    const pattern = args[index + 1];
    if (pattern) {
      vitestArgs.push(pattern);
      index += 1;
    }
    continue;
  }

  if (arg.startsWith('--testPathPattern=')) {
    vitestArgs.push(arg.slice('--testPathPattern='.length));
    continue;
  }

  vitestArgs.push(arg);
}

const vitestRoot = dirname(require.resolve('vitest/package.json'));
const vitestBin = join(vitestRoot, 'vitest.mjs');
const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
  stdio: 'inherit',
  cwd: fileURLToPath(new URL('..', import.meta.url)),
});

process.exit(result.status ?? 1);
