/**
 * Align dependency versions across workspace package.json files.
 * Run from repo root: node scripts/sync-package-versions.mjs
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const VERSIONS = {
  '@types/node': '25.9.1',
  typescript: '6.0.3',
  tsup: '8.5.1',
  vitest: '4.1.7',
  zod: '4.4.3',
  '@nestjs/common': '^11.1.24',
  '@nestjs/core': '^11.1.24',
  '@nestjs/platform-express': '^11.1.24',
  '@nestjs/testing': '^11.1.24',
  '@nestjs/terminus': '^11.1.1',
  express: '^5.2.1',
  '@types/express': '^5.0.6',
  fastify: '^5.8.5',
  'fastify-plugin': '^5.1.0',
  hono: '^4.12.23',
  '@hono/node-server': '^2.0.4',
  next: '^16.2.6',
  ai: '^6.0.191',
  '@ai-sdk/provider': '3.0.10',
  '@langchain/core': '^1.1.48',
  '@mastra/core': '^1.36.0',
  supertest: '^7.2.2',
  '@types/supertest': '^7.2.0',
  tsx: '^4.22.3',
  'reflect-metadata': '^0.2.2',
  rxjs: '^7.8.2',
  '@eslint/js': '10.0.1',
  eslint: '10.4.0',
  'eslint-config-prettier': '^10.1.8',
  jiti: '2.7.0',
  prettier: '3.8.3',
  turbo: '^2.9.14',
  typedoc: '^0.28.19',
  'typescript-eslint': '8.59.4',
};

function findWorkspacePackages(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const pkgJson = join(full, 'package.json');
    try {
      statSync(pkgJson);
      results.push(pkgJson);
    } catch {
      /* not a workspace package */
    }
  }
  return results;
}

function syncSection(section) {
  if (!section || typeof section !== 'object') return;
  for (const [name, version] of Object.entries(VERSIONS)) {
    if (name in section) {
      section[name] = version;
    }
  }
}

const files = [
  join(ROOT, 'package.json'),
  ...findWorkspacePackages(join(ROOT, 'packages')),
  ...findWorkspacePackages(join(ROOT, 'examples', 'http-agents')),
];

for (const pkgPath of files) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  syncSection(pkg.dependencies);
  syncSection(pkg.devDependencies);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`updated ${pkgPath.replace(`${ROOT}/`, '')}`);
}
