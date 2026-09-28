import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      // tsup injects baseUrl "." for DTS; silence TS 6 deprecation
      ignoreDeprecations: '6.0',
    },
  },
  clean: true,
  sourcemap: true,
  external: ['@typesafe-ai/sdk', 'ottrix'],
});
