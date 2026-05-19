# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet._

## [1.0.0] - 2026-05-19

### Added

- Initial public release as **agentic-fabric** on npm
- **Agent** — ReAct loop with streaming, planners, reflectors, and step limits
- **Providers** — Anthropic, OpenAI-compatible, and Ollama via native `fetch` (no vendor SDKs bundled)
- **Tools** — `FunctionTool`, `BaseTool`, `ToolRegistry`, `ToolNotFoundError`, and MCP client/provider (stdio + SSE)
- **Memory** — working, semantic (RAG), and episodic memory modules
- **Guardrails** — middleware for PII, budgets, content filters, human approval, and audit logging
- **Observability** — structured logging, telemetry spans/metrics, and run replay
- **Orchestration** — sequential, parallel, router, and hierarchical workflows; YAML/JSON loader
- **Configuration** — `loadConfig()`, `.agenticrc.*`, and `AGENTIC_*` environment variables
- **Convenience API** — `createAgent()`, `quickAgent()`
- Subpath exports: `types`, `providers`, `tools`, `memory`, `orchestration`, `guardrails`, `observability`, `agent`
- Runnable examples under `examples/`
- Integration test suite and GitHub Actions CI

### Fixed

- Anthropic/OpenAI missing API key throws `ProviderError` with `code: 'auth'`
- MCP JSON-RPC parse failures throw `MCPProtocolError` instead of generic `Error`

[1.0.0]: https://github.com/ashwinpaulallen/agent-fabric/releases/tag/v1.0.0
