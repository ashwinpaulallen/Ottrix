# Contributing to Ottrix

Thank you for contributing to **Ottrix**. This guide covers how to extend the framework and submit changes.

## Development setup

```bash
git clone https://github.com/ashwinpaulallen/ottrix.git
cd ottrix
npm install
npm run build
```

Before opening a PR, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:exports
```

Or run the full publish gate:

```bash
npm run prepublish:check
```

## Code style

- **TypeScript** with strict typing; prefer explicit types on public APIs
- **ESM** — use `.js` extensions in `src/` import paths
- Match existing naming, file layout, and JSDoc on exported symbols
- Run `npm run lint` and `npm run format:check` (or `npm run format` to fix)
- Keep changes focused; avoid unrelated refactors in the same PR

## Testing requirements

- Add or update **Vitest** tests under `tests/` for new behavior
- Unit tests for isolated modules; integration tests under `tests/integration/` for end-to-end flows
- Use existing fixtures (`MockCompletionProvider`, fake MCP transports) where possible
- All tests must pass: `npm test`
- Typecheck must pass: `npm run typecheck`

## Adding a provider

Built-in providers use **HTTP APIs via `fetch`**, not vendor SDKs. To add a new first-party provider:

1. **Create** `src/providers/<name>.ts` extending `BaseProvider` from `./base.js`
2. **Implement** protected methods:
   - `_rawComplete(params)` — map `CompletionParams` to your API and return `CompletionResult`
   - `_rawStream(params)` — yield `StreamChunk` events
   - `_countTokens(messages)` — optional token estimation
3. **Export** a factory (e.g. `createMyProvider(config)`) and register types in `src/providers/index.ts`
4. **Wire** `createAgent()` in `src/factory.ts` if it should be selectable by name
5. **Add** `src/providers/<name>.ts` to `tsup.config.ts` `entry` array
6. **Add** tests in `tests/providers/` and document env vars in `README.md`
7. **Export** subpath `./providers/<name>` is covered by the `./providers/*` wildcard in `package.json`

For private or experimental APIs, users can extend `BaseProvider` without publishing to the main package — see [examples/custom-provider](examples/custom-provider/).

### Custom providers (downstream)

Consumers implement `BaseProvider` and pass the instance to `new Agent({ provider })` or `createAgent({ provider: myProvider })`.

## Adding a tool

1. **Prefer** `FunctionTool` for simple async handlers with JSON Schema `inputSchema`
2. **Subclass** `BaseTool` when you need custom validation, lifecycle hooks, or streaming events
3. **Register** tools on a `ToolRegistry` and pass `toolRegistry` to `Agent`, or pass `tools: [...]` to `createAgent()`
4. **Add** tests under `tests/tools/` exercising execute + schema validation
5. For **MCP** tools, use `MCPClient` / `MCPToolProvider` — see `tests/tools/mcp/` and `examples/mcp-integration/`

## Adding a workflow type

1. **Implement** a class in `src/orchestration/` that follows existing patterns (`run(input: string): Promise<WorkflowResult>`)
2. **Reuse** `runAgentStep` from `src/orchestration/runner.ts` where appropriate
3. **Export** from `src/orchestration/index.ts` and the main `src/index.ts` barrel
4. **Extend** `WorkflowLoader` / `workflow-definition.ts` if the type should be loadable from YAML/JSON
5. **Add** tests in `tests/orchestration/` and an example if the UX is non-obvious
6. **Document** the workflow type in `README.md`

## Documentation

- Update `README.md` for user-facing API or env changes
- Update implementation guides in `packages/*/docs/` when behavior changes (core modules in `packages/core/docs/`)
- Add an entry to `CHANGELOG.md` under `[Unreleased]` (or the target version)
- Run `npm run docs` to regenerate API docs (`docs/api/` — not published to npm)

## Pull request process

1. **Open an issue** for large features or breaking changes before significant work
2. **Fork** the repo and branch from `main`
3. **Implement** with tests and docs
4. **Ensure CI passes** — GitHub Actions runs `npm audit`, then typecheck, lint, test, and build on Node 20, 22, and 24
5. **Open a PR** with:
   - Clear summary of what and why
   - Test plan (commands run, scenarios covered)
   - Breaking changes called out explicitly
6. **Address review** feedback; maintain a single logical change per PR when possible

### PR checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] `npm run verify:exports` passes (after build)
- [ ] README / CHANGELOG updated for public API changes
- [ ] No secrets or API keys committed

## Publishing (maintainers)

```bash
npm run prepublish:check
npm publish
```

The `prepublishOnly` script runs lint, typecheck, tests, build, export verification, and `npm pack --dry-run`.

## Questions

Open a [GitHub issue](https://github.com/ashwinpaulallen/ottrix/issues) for design questions or bugs.
