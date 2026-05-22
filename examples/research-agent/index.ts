/**
 * Research agent with mocked web search + note-taking tools.
 * Demonstrates the ReAct loop across multiple tool calls (no API keys).
 */
import { Agent, FunctionTool, ToolRegistry } from 'agent-kit';
import { DemoProvider, demoToolUse } from '../shared/demo-provider.js';

// --- Mock tools (stand in for real web search / notes APIs) ---

const notes = new Map<string, string>();

const webSearchTool = new FunctionTool({
  name: 'web_search',
  description: 'Search the web for a query and return short snippets',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  execute: async (input) => {
    const query = String(input.query ?? '');
    return {
      results: [
        { title: `Overview of ${query}`, snippet: `${query} is a fast-growing topic in 2026.` },
        { title: `${query} FAQ`, snippet: `Common questions about ${query} answered briefly.` },
      ],
    };
  },
});

const saveNoteTool = new FunctionTool({
  name: 'save_note',
  description: 'Save a research note by title',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['title', 'body'],
  },
  execute: async (input) => {
    const title = String(input.title ?? 'untitled');
    notes.set(title, String(input.body ?? ''));
    return { saved: true, title, count: notes.size };
  },
});

// --- Mock LLM: search → save note → final answer ---

const provider = new DemoProvider()
  .enqueue(
    demoToolUse([
      { id: 'tu_1', name: 'web_search', input: { query: 'agent frameworks' } },
    ]),
  )
  .enqueue(
    demoToolUse([
      {
        id: 'tu_2',
        name: 'save_note',
        input: {
          title: 'agent-frameworks',
          body: 'Agent frameworks coordinate LLMs, tools, and memory.',
        },
      },
    ]),
  )
  .textReply(
    'Research complete. I searched the web and saved a note titled "agent-frameworks". ' +
      'Key finding: frameworks coordinate LLMs, tools, and memory.',
  );

const registry = new ToolRegistry();
registry.register(webSearchTool);
registry.register(saveNoteTool);

const agent = new Agent({
  name: 'researcher',
  provider,
  toolRegistry: registry,
  systemPrompt: 'You are a research assistant. Use tools, then summarize findings.',
  maxSteps: 6,
});

const result = await agent.run('Research agent frameworks and save notes.');

console.log('--- Agent response ---\n');
console.log(result.response);
console.log('\n--- Saved notes ---');
for (const [title, body] of notes) {
  console.log(`\n# ${title}\n${body}`);
}
console.log('\n--- Trace ---');
console.log(`LLM calls: ${provider.completeCalls}`);
console.log(`Steps: ${result.steps.length} (tool calls: ${result.steps.filter((s) => s.type === 'tool_call').length})`);
console.log(`Stop reason: ${result.metadata.stopReason}`);
