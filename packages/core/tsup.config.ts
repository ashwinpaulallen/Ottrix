import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/index': 'src/providers/index.ts',
    'providers/registry': 'src/providers/registry.ts',
    'providers/anthropic': 'src/providers/anthropic.ts',
    'providers/openai': 'src/providers/openai.ts',
    'providers/ollama': 'src/providers/ollama.ts',
    'providers/errors': 'src/providers/errors.ts',
    'providers/base': 'src/providers/base.ts',
    'types/index': 'src/types/index.ts',
    'tools/index': 'src/tools/index.ts',
    'memory/index': 'src/memory/index.ts',
    'orchestration/index': 'src/orchestration/index.ts',
    'guardrails/index': 'src/guardrails/index.ts',
    'observability/index': 'src/observability/index.ts',
    'agent/index': 'src/agent/index.ts',
    'evals/index': 'src/evals/index.ts',
    'observability/exporters/index': 'src/observability/exporters/index.ts',
    'observability/exporters/webhook': 'src/observability/exporters/webhook.ts',
    'http/index': 'src/http/index.ts',
    'testing/index': 'src/testing/index.ts',
    'testing/contract': 'src/testing/contract-entry.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'es2022',
  dts: {
    compilerOptions: {
      // tsup injects baseUrl "." for DTS; silence TS 6 deprecation (IDE TS 5.x rejects this in tsconfig)
      ignoreDeprecations: '6.0',
    },
  },
  treeshake: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
  external: ['vitest', 'zod', 'ottrix'],
});
