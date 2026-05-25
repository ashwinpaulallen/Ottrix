# Fastify agent example

Minimal Ottrix agent HTTP server using `@ottrix/fastify`.

## Prerequisites

- Node.js 20+
- `ANTHROPIC_API_KEY` set

From the **monorepo root**, build packages once:

```bash
npm install && npm run build
```

## Run

```bash
cd examples/http-agents/fastify-agent
ANTHROPIC_API_KEY=sk-... npm start
```

## Try it

```bash
curl -s -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is 2+2?"}'

curl -N 'http://localhost:3000/chat/stream?message=Hello'

curl -s http://localhost:3000/chat/health
```

See [BACKEND_ADAPTERS.md](../../../BACKEND_ADAPTERS.md) for request/response formats.
