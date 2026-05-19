# Multi-agent pipeline

Runs **researcher → analyzer → writer** in a `SequentialWorkflow`, printing each step's output.

## What it demonstrates

- Multiple `Agent` instances with different roles
- `inputMapper` to pipe prior responses into the next agent
- `WorkflowResult.steps` for intermediate artifacts

## Run

```bash
npm run build   # from repo root
cd examples/multi-agent-pipeline
npm install
npm start

# Optional custom topic:
npm start -- "retrieval-augmented generation"
```

No API keys — demo providers return fixed text per stage.

## Live models

Swap each `DemoProvider` for `createAgent({ name, provider: 'anthropic', ... })` and set `ANTHROPIC_API_KEY`.
