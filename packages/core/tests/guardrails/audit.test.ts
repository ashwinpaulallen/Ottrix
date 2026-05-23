import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/guardrails/audit.js';

describe('AuditLogger', () => {
  it('records LLM and tool events and exports JSON', async () => {
    const custom: string[] = [];
    const audit = new AuditLogger({
      agentName: 'audited',
      console: false,
      handler: (entry) => {
        custom.push(entry.type);
      },
    });

    await audit.beforeLlm({
      phase: 'llm',
      timing: 'pre',
      agentName: 'audited',
      messages: [{ role: 'user', content: 'hi' }],
      params: { messages: [{ role: 'user', content: 'hi' }] },
    });

    await audit.afterTool({
      phase: 'tool',
      timing: 'post',
      agentName: 'audited',
      toolName: 'search',
      input: { q: 'test' },
      output: 'results',
      durationMs: 12,
    });

    expect(custom).toEqual(['llm_pre', 'tool_post']);
    expect(audit.getLogs()).toHaveLength(2);

    const exported = JSON.parse(audit.exportLogs()) as unknown[];
    expect(exported).toHaveLength(2);
    expect((exported[0] as { agentName: string }).agentName).toBe('audited');
  });
});
