import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  clean: true,
  sourcemap: true,
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/terminus',
    'ottrix',
    'rxjs',
    'reflect-metadata',
  ],
});
