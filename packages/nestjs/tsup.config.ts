import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'es2022',
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  treeshake: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/terminus',
    '@nestjs/bull',
    'ottrix',
    'rxjs',
    'reflect-metadata',
  ],
});
