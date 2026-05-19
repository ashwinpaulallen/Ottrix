import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  DEFAULT_AGENTIC_CONFIG,
  defineConfig,
  discoverConfigFile,
  loadConfig,
  mergeAgenticConfig,
  readConfigFromEnv,
  resetConfigCache,
} from '../src/config.js';
import { resetAgenticEnvCache } from '../src/env.js';

describe('readConfigFromEnv', () => {
  it('parses AGENTIC_* variables and provider API keys', () => {
    const partial = readConfigFromEnv({
      AGENTIC_PROVIDER: 'openai',
      AGENTIC_MODEL: 'gpt-4o-mini',
      AGENTIC_MAX_STEPS: '12',
      AGENTIC_MAX_TOKEN_BUDGET: '50000',
      AGENTIC_LOG_LEVEL: 'debug',
      AGENTIC_TELEMETRY_ENABLED: 'false',
      AGENTIC_TELEMETRY_EXPORTER: 'console',
      AGENTIC_GUARDRAILS_PII_DETECTION: 'false',
      AGENTIC_GUARDRAILS_MAX_COST_USD: '2.5',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    });

    expect(partial.defaultProvider).toBe('openai');
    expect(partial.defaultModel).toBe('gpt-4o-mini');
    expect(partial.maxSteps).toBe(12);
    expect(partial.maxTokenBudget).toBe(50_000);
    expect(partial.logLevel).toBe('debug');
    expect(partial.telemetry).toEqual({ enabled: false, exporter: 'console' });
    expect(partial.guardrails).toEqual({ piiDetection: false, maxCostUsd: 2.5 });
    expect(partial.providers?.anthropic?.apiKey).toBe('sk-ant');
    expect(partial.providers?.openai?.apiKey).toBe('sk-openai');
    expect(partial.providers?.ollama?.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('warns on invalid AGENTIC_LOG_LEVEL values', () => {
    const { warnings } = loadConfig({
      configPath: false,
      env: { AGENTIC_LOG_LEVEL: 'verbose' },
    });
    expect(warnings.some((w) => w.code === 'invalid_env_value')).toBe(true);
  });

  it('parses AGENTIC_<PROVIDER>_* overrides', () => {
    const partial = readConfigFromEnv({
      AGENTIC_ANTHROPIC_API_KEY: 'from-prefixed',
      AGENTIC_OPENAI_MODEL: 'gpt-4.1',
    });

    expect(partial.providers?.anthropic?.apiKey).toBe('from-prefixed');
    expect(partial.providers?.openai?.model).toBe('gpt-4.1');
  });
});

describe('mergeAgenticConfig', () => {
  it('deep-merges nested provider entries', () => {
    const merged = mergeAgenticConfig(DEFAULT_AGENTIC_CONFIG, {
      providers: {
        anthropic: { apiKey: 'a' },
      },
    }, {
      providers: {
        anthropic: { model: 'claude-custom' },
      },
    });

    expect(merged.providers.anthropic).toEqual({
      apiKey: 'a',
      model: 'claude-custom',
    });
  });
});

describe('loadConfig layering', () => {
  let tempDir: string;

  afterEach(() => {
    resetConfigCache();
    resetAgenticEnvCache();
  });

  it('merges defaults < file < env < overrides', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentic-config-'));
    writeFileSync(
      join(tempDir, '.agenticrc.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        maxSteps: 5,
        defaultModel: 'from-file',
      }),
    );

    const { config, warnings } = loadConfig({
      cwd: tempDir,
      env: {
        AGENTIC_MAX_STEPS: '20',
        AGENTIC_MODEL: 'from-env',
      },
      overrides: {
        maxSteps: 30,
      },
    });

    expect(config.maxSteps).toBe(30);
    expect(config.defaultModel).toBe('from-env');
    expect(config.defaultProvider).toBe('anthropic');
    expect(warnings).toEqual([]);
  });

  it('loads YAML config files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentic-config-'));
    writeFileSync(
      join(tempDir, '.agenticrc.yaml'),
      `defaultProvider: ollama
maxSteps: 7
telemetry:
  enabled: true
  exporter: none
`,
    );

    const { config } = loadConfig({ cwd: tempDir, env: {} });
    expect(config.defaultProvider).toBe('ollama');
    expect(config.maxSteps).toBe(7);
    expect(config.telemetry).toEqual({ enabled: true, exporter: 'none' });
  });

  it('discovers .agenticrc.json before yaml', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentic-config-'));
    writeFileSync(join(tempDir, '.agenticrc.json'), JSON.stringify({ maxSteps: 3 }));
    writeFileSync(join(tempDir, '.agenticrc.yaml'), 'maxSteps: 99');

    expect(discoverConfigFile(tempDir)).toBe(join(tempDir, '.agenticrc.json'));

    const { config } = loadConfig({ cwd: tempDir, env: {} });
    expect(config.maxSteps).toBe(3);
  });

  it('warns on deprecated options', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentic-config-'));
    writeFileSync(
      join(tempDir, '.agenticrc.json'),
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
      }),
    );

    const { config, warnings } = loadConfig({ cwd: tempDir, env: {} });
    expect(config.defaultProvider).toBe('openai');
    expect(config.defaultModel).toBe('gpt-4o');
    expect(warnings.some((w) => w.code === 'deprecated_option')).toBe(true);
  });

  it('throws on invalid values', () => {
    expect(() =>
      loadConfig({
        configPath: false,
        env: {},
        overrides: { maxSteps: 0 },
      }),
    ).toThrow(ConfigValidationError);
  });
});

describe('defineConfig', () => {
  it('returns the config object unchanged', () => {
    const input = defineConfig({ defaultProvider: 'openai', maxSteps: 8 });
    expect(input).toEqual({ defaultProvider: 'openai', maxSteps: 8 });
  });
});
