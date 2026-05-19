# Custom provider

Implements a vendor-specific LLM by extending `BaseProvider`.

## What it demonstrates

- Subclassing `BaseProvider` and implementing `_rawComplete`, `_rawStream`, `_countTokens`
- Using `CompletionProvider` through the standard `Agent` API
- Configuration via environment variables (no real keys required)

## Environment variables

| Variable | Purpose |
|----------|---------|
| `HYPOTHETICAL_API_KEY` | Would authenticate real HTTP calls (unused in demo) |
| `HYPOTHETICAL_BASE_URL` | API base URL (default `https://api.hypothetical.example/v1`) |
| `HYPOTHETICAL_MODEL` | Model id (default `hypothetical-large`) |

## Run

```bash
npm run build   # from repo root
cd examples/custom-provider
npm install
npm start
```

To wire a real API, replace the synthesized responses in `_rawComplete` with `this.makeRequest()` calls to your HTTP endpoints.
