# Research agent

An agent with **mock** web search and note-taking tools, driven by a queued demo LLM (no API keys).

## What it demonstrates

- Defining tools with `FunctionTool`
- Registering tools on `ToolRegistry`
- The ReAct loop: LLM → tool → LLM → tool → final answer

## Run

```bash
# From repo root
npm run build

cd examples/research-agent
npm install
npm start
```

## Optional: live model

Set `ANTHROPIC_API_KEY` and replace `DemoProvider` with `createAgent({ provider: 'anthropic', tools: [...] })` if you want a real model to plan tool calls.

## Output

Prints the final summary, saved notes, and step counts from the agent trace.
