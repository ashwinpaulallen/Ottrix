# agent-kit examples

Runnable examples that use **mock/demo providers** by default so no API keys are required.

## Prerequisites

```bash
# From repository root
npm install
npm run build
```

Each example is a small package:

```bash
cd examples/<example-name>
npm install
npm start
```

## Examples

| Directory | Description |
|-----------|-------------|
| [simple-chatbot](./simple-chatbot/) | CLI chatbot with streaming (`readline`) |
| [research-agent](./research-agent/) | ReAct loop with mock search + notes tools |
| [multi-agent-pipeline](./multi-agent-pipeline/) | `SequentialWorkflow` (researcher → analyzer → writer) |
| [mcp-integration](./mcp-integration/) | MCP tool discovery + agent |
| [custom-provider](./custom-provider/) | Extend `BaseProvider` for a custom API |

## Live LLM providers

Several examples support optional live Anthropic usage:

```bash
export ANTHROPIC_API_KEY=your-key
export AGENTIC_MODEL=claude-sonnet-4-20250514   # optional
```

See each example's README for details.

## Shared code

[`shared/demo-provider.ts`](./shared/demo-provider.ts) — queue-based mock `CompletionProvider` used by multiple examples.
