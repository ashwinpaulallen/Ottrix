# Simple chatbot

A minimal readline CLI that streams assistant replies to stdout.

## What it demonstrates

- Creating an agent with `createAgent()` or `Agent` + a provider
- A conversational loop with `agent.stream()`
- Mock mode (no API key) vs live Anthropic via environment variables

## Prerequisites

From the repository root:

```bash
npm install
npm run build
```

## Run (mock — no API key)

```bash
cd examples/simple-chatbot
npm install
npm start
```

Type messages and `exit` to quit. In mock mode the demo provider echoes your input.

## Run (live Anthropic)

```bash
export ANTHROPIC_API_KEY=your-key-here
export AGENTIC_MODEL=claude-sonnet-4-20250514   # optional
npm start
```

## Files

| File | Role |
|------|------|
| `index.ts` | Readline loop + streaming to stdout |
| `agent.ts` | Provider selection (demo vs Anthropic) |
