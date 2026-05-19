import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/*/index.ts',
    'src/providers/index.ts',
    'src/providers/registry.ts',
    'src/providers/anthropic.ts',
    'src/providers/openai.ts',
    'src/providers/ollama.ts',
    'src/providers/errors.ts',
    'src/providers/base.ts',
  ],
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
});
