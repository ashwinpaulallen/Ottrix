/**
 * Ensures `npm pack` does not include dev-only directories (examples, docs, src, tests).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'packages/core');
const FORBIDDEN_TOP_LEVEL = new Set(['examples', 'docs', 'src', 'tests', '.github', 'scripts']);

const filename = execSync('npm pack --silent', { encoding: 'utf8', cwd: coreDir }).trim();

const tarball = join(coreDir, filename);

const tempDir = mkdtempSync(join(tmpdir(), 'agentic-pack-'));
try {
  execSync(`tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(tempDir)}`, {
    stdio: 'pipe',
  });

  const packageRoot = join(tempDir, 'package');
  const entries = execSync(`ls -1 ${JSON.stringify(packageRoot)}`, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const violations = entries.filter((name) => FORBIDDEN_TOP_LEVEL.has(name));

  if (violations.length > 0) {
    console.error('npm pack must not include:', violations.join(', '));
    console.error('Allowed top-level entries: dist/, README.md, package.json, LICENSE');
    console.error('Fix package.json "files" to whitelist only publish artifacts.');
    process.exit(1);
  }

  const allowed = new Set(['dist', 'README.md', 'package.json', 'LICENSE']);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    console.error('Unexpected entries in npm pack:', unexpected.join(', '));
    process.exit(1);
  }

  console.log('✓ npm pack contains only:', entries.sort().join(', '));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
