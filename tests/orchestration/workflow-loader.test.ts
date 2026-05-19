import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { HierarchicalWorkflow } from '../../src/orchestration/hierarchical.js';
import { ParallelWorkflow } from '../../src/orchestration/parallel.js';
import { RouterWorkflow } from '../../src/orchestration/router.js';
import { SequentialWorkflow } from '../../src/orchestration/sequential.js';
import {
  LoadedWorkflow,
  ParallelThenWorkflow,
  WorkflowLoader,
  normalizeWorkflowDefinition,
  validateWorkflowDefinition,
} from '../../src/orchestration/workflow-loader.js';
import { parseYamlSubset } from '../../src/orchestration/yaml-parse.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

const examplesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../examples',
);

function createLoader(): WorkflowLoader {
  const providers = new ProviderRegistry();
  providers.register('openai', new MockCompletionProvider().enqueue(textCompletion('ok')));
  return new WorkflowLoader({ providers });
}

describe('parseYamlSubset', () => {
  it('parses mappings, lists, and multiline strings', () => {
    const parsed = parseYamlSubset(`
name: test
agents:
  a:
    provider: openai
    systemPrompt: |
      line one
      line two
workflow:
  type: sequential
  steps:
    - agent: a
`);
    const def = normalizeWorkflowDefinition(parsed);
    expect(def.name).toBe('test');
    expect(def.agents.a?.systemPrompt).toContain('line one');
    expect(def.workflow.type).toBe('sequential');
  });
});

describe('validateWorkflowDefinition', () => {
  it('rejects unknown agent references', () => {
    const def = normalizeWorkflowDefinition({
      name: 'bad',
      description: 'x',
      agents: { a: { provider: 'openai', systemPrompt: 'hi' } },
      workflow: { type: 'sequential', steps: [{ agent: 'missing' }] },
    });

    expect(() => validateWorkflowDefinition(def)).toThrow(/unknown agent "missing"/);
  });

  it('rejects rules router without rules or fallback', () => {
    const def = normalizeWorkflowDefinition({
      name: 'router',
      description: 'x',
      agents: { a: { provider: 'openai', systemPrompt: 'hi' } },
      workflow: {
        type: 'router',
        router: { type: 'rules', rules: [] },
      },
    });

    expect(() => validateWorkflowDefinition(def)).toThrow(/at least one rule or a fallback/i);
  });

  it('rejects invalid router regex at validation time', () => {
    const def = normalizeWorkflowDefinition({
      name: 'router',
      description: 'x',
      agents: { a: { provider: 'openai', systemPrompt: 'hi' } },
      workflow: {
        type: 'router',
        router: {
          type: 'rules',
          fallback: 'a',
          rules: [{ pattern: '/[invalid/', agent: 'a' }],
        },
      },
    });

    expect(() => validateWorkflowDefinition(def)).toThrow(/invalid regex/i);
  });

  it('rejects duplicate sequential agents as circular hand-offs', () => {
    const def = normalizeWorkflowDefinition({
      name: 'dup',
      description: 'x',
      agents: {
        a: { provider: 'openai', systemPrompt: 'hi' },
        b: { provider: 'openai', systemPrompt: 'hi' },
      },
      workflow: {
        type: 'sequential',
        steps: [{ agent: 'a' }, { agent: 'a' }],
      },
    });

    expect(() => validateWorkflowDefinition(def)).toThrow(/duplicate agent "a"/);
  });
});

describe('WorkflowLoader example files', () => {
  const loader = createLoader();

  it('loads research-and-write.yaml as a sequential workflow', async () => {
    const loaded = await loader.loadFromFile(join(examplesDir, 'research-and-write.yaml'));

    expect(loaded).toBeInstanceOf(LoadedWorkflow);
    expect(loaded.describe()).toMatchObject({
      name: 'research-and-write',
      type: 'sequential',
      agentNames: ['researcher', 'writer'],
    });
    expect(loaded.describe().sequential?.map((s) => s.agent)).toEqual(['researcher', 'writer']);
    expect(loaded.workflow).toBeInstanceOf(SequentialWorkflow);
    expect(loaded.agents.researcher?.getName()).toBe('researcher');
  });

  it('loads multi-perspective.yaml as parallel-then workflow', async () => {
    const loaded = await loader.loadFromFile(join(examplesDir, 'multi-perspective.yaml'));

    expect(loaded.describe().type).toBe('parallel-then');
    expect(loaded.describe().parallel?.agents).toEqual([
      'analyst_optimist',
      'analyst_skeptic',
      'analyst_pragmatist',
    ]);
    expect(loaded.describe().parallel?.then?.agent).toBe('synthesizer');
    expect(loaded.workflow).toBeInstanceOf(ParallelThenWorkflow);
  });

  it('loads customer-support.yaml as a rules router workflow', async () => {
    const loaded = await loader.loadFromFile(join(examplesDir, 'customer-support.yaml'));

    expect(loaded.describe().type).toBe('router');
    expect(loaded.describe().router?.type).toBe('rules');
    expect(loaded.describe().router?.fallback).toBe('general');
    expect(loaded.describe().router?.rules?.length).toBeGreaterThanOrEqual(4);
    expect(loaded.workflow).toBeInstanceOf(RouterWorkflow);
  });
});

describe('WorkflowLoader.loadFromObject', () => {
  it('gives hierarchical manager a tool registry for delegate', async () => {
    const loader = createLoader();
    const loaded = loader.loadFromObject({
      name: 'hierarchy-delegate',
      description: 'delegate test',
      agents: {
        manager: { provider: 'openai', systemPrompt: 'manage' },
        worker: { provider: 'openai', systemPrompt: 'work' },
      },
      workflow: {
        type: 'hierarchical',
        manager: 'manager',
        workers: ['worker'],
      },
    });

    expect(loaded.agents.manager?.getToolRegistry()).toBeDefined();
    const output = await loaded.workflow.run('Do work');
    expect(output.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('builds a hierarchical workflow with resolved agents', () => {
    const loader = createLoader();
    const loaded = loader.loadFromObject({
      name: 'hierarchy',
      description: 'test hierarchy',
      agents: {
        manager: { provider: 'openai', systemPrompt: 'manage', tools: [] },
        worker: { provider: 'openai', systemPrompt: 'work' },
      },
      workflow: {
        type: 'hierarchical',
        manager: 'manager',
        workers: ['worker'],
      },
    });

    expect(loaded.workflow).toBeInstanceOf(HierarchicalWorkflow);
    expect(loaded.agents.manager).toBeDefined();
    expect(loaded.agents.worker).toBeDefined();
  });

  it('builds a plain parallel workflow', () => {
    const loader = createLoader();
    const loaded = loader.loadFromObject({
      name: 'parallel',
      description: 'parallel test',
      agents: {
        a: { provider: 'openai', systemPrompt: 'a' },
        b: { provider: 'openai', systemPrompt: 'b' },
      },
      workflow: {
        type: 'parallel',
        agents: ['a', 'b'],
      },
    });

    expect(loaded.workflow).toBeInstanceOf(ParallelWorkflow);
    expect(loaded.describe().parallel?.agents).toEqual(['a', 'b']);
  });

  it('loads JSON definitions', async () => {
    const loader = createLoader();
    const jsonPath = join(examplesDir, 'research-and-write.json');
    const { writeFile, unlink } = await import('node:fs/promises');
    const yamlLoaded = await loader.loadFromFile(join(examplesDir, 'research-and-write.yaml'));
    await writeFile(jsonPath, JSON.stringify(yamlLoaded.definition, null, 2));
    const jsonLoaded = await loader.loadFromFile(jsonPath);
    await unlink(jsonPath);

    expect(jsonLoaded.describe().name).toBe('research-and-write');
    expect(jsonLoaded.workflow).toBeInstanceOf(SequentialWorkflow);
  });
});
