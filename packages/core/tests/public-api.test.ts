import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  loadConfig,
  readAgenticEnv,
  getAgenticEnv,
  resetAgenticEnvCache,
  resetConfigCache,
  isBuiltInProviderName,
} from '../src/index.js';
import { MockCompletionProvider, textCompletion } from './fixtures/mock-provider.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe('public API / DX', () => {
  afterEach(() => {
    resetAgenticEnvCache();
    resetConfigCache();
  });

  it('uses separate agentic vs LLM ProviderConfig shapes', () => {
    type AgenticProviderConfig = import('../src/config.js').AgenticProviderConfig;
    type LlmProviderConfig = import('../src/types/provider.js').ProviderConfig;

    const agentic: AgenticProviderConfig = { apiKey: 'x', model: 'm' };
    const llm: LlmProviderConfig = { apiKey: 'x', defaultModel: 'm' };

    expect(agentic.model).toBe('m');
    expect(llm.defaultModel).toBe('m');
  });

  it('getAgenticEnv merges config files unlike readAgenticEnv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-api-'));
    writeFileSync(
      join(dir, '.agenticrc.json'),
      JSON.stringify({ defaultModel: 'from-rc-file', maxSteps: 42 }),
    );

    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      resetAgenticEnvCache();

      expect(readAgenticEnv({}).model).toBeUndefined();
      expect(getAgenticEnv().model).toBe('from-rc-file');
      expect(getAgenticEnv().maxSteps).toBe(42);
    } finally {
      process.chdir(previousCwd);
      resetAgenticEnvCache();
    }
  });

  it('loadConfig honors AGENTIC_CONFIG_PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-api-'));
    const customPath = join(dir, 'custom.agentic.json');
    writeFileSync(customPath, JSON.stringify({ maxSteps: 99 }));

    const { config } = loadConfig({
      cwd: dir,
      env: { AGENTIC_CONFIG_PATH: customPath },
    });

    expect(config.maxSteps).toBe(99);
  });

  it('createAgent rejects unknown string providers with a clear error', () => {
    expect(() =>
      createAgent({
        provider: 'azure' as 'anthropic',
        telemetry: false,
        guardrails: false,
        memory: false,
      }),
    ).toThrow(/unknown provider "azure"/);
  });

  it('createAgent allows custom CompletionProvider instances', async () => {
    const provider = new MockCompletionProvider().enqueue(textCompletion('ok', usage));

    const agent = createAgent({
      provider,
      telemetry: false,
      guardrails: false,
      memory: false,
    });

    expect(await agent.run('hi')).toMatchObject({ response: 'ok' });
  });

  it('isBuiltInProviderName identifies supported providers', () => {
    expect(isBuiltInProviderName('anthropic')).toBe(true);
    expect(isBuiltInProviderName('Azure')).toBe(false);
  });
});
