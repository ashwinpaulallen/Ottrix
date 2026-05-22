#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { AGENTIC_FABRIC_VERSION } from '../index.js';
import {
  applyTelemetryRetention,
  configureTraceExportFromConfig,
  shutdownObservability,
} from '../observability/index.js';
import { serveMCP } from '../tools/serve.js';
import { ToolRegistry } from '../tools/registry.js';

interface CliArgs {
  config?: string;
  name: string;
  version: string;
  transport: 'stdio' | 'sse';
  port: number;
  host: string;
}

interface McpServeConfigFile {
  name?: string;
  version?: string;
  transport?: 'stdio' | 'sse';
  port?: number;
  host?: string;
  setup?: (ctx: { registry: ToolRegistry }) => void | Promise<void>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    name: 'agentic-fabric',
    version: AGENTIC_FABRIC_VERSION,
    transport: 'stdio',
    port: 3001,
    host: '127.0.0.1',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case '--config':
      case '-c':
        args.config = next;
        index += 1;
        break;
      case '--name':
        args.name = next ?? args.name;
        index += 1;
        break;
      case '--version':
        args.version = next ?? args.version;
        index += 1;
        break;
      case '--transport':
        args.transport = next === 'sse' ? 'sse' : 'stdio';
        index += 1;
        break;
      case '--port':
        args.port = Number(next ?? args.port);
        index += 1;
        break;
      case '--host':
        args.host = next ?? args.host;
        index += 1;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return args;
}

function printHelp(): void {
  process.stdout.write(`agentic-serve — expose agentic-fabric tools over MCP

Usage:
  agentic-serve [options]

Options:
  -c, --config <file>     JS/TS config module with optional setup(registry)
      --name <name>       MCP server name (default: agentic-fabric)
      --version <ver>     MCP server version (default: package version)
      --transport <mode>  stdio | sse (default: stdio)
      --port <number>     SSE port (default: 3001)
      --host <host>       SSE bind host (default: 127.0.0.1)
  -h, --help              Show this help

Example config (mcp.config.mjs):
  export default {
    name: 'my-tools',
    transport: 'stdio',
    setup({ registry }) {
      registry.register(new FunctionTool({ ... }));
    },
  };
`);
}

async function loadConfigFile(path: string): Promise<McpServeConfigFile> {
  const url = pathToFileURL(path).href;
  const module = (await import(url)) as { default?: McpServeConfigFile };
  return module.default ?? {};
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let fileConfig: McpServeConfigFile = {};

  if (args.config) {
    fileConfig = await loadConfigFile(args.config);
  }

  const { config: agenticConfig } = loadConfig();
  configureTraceExportFromConfig(agenticConfig.telemetry);
  applyTelemetryRetention({
    maxFinishedSpans: agenticConfig.telemetry.maxFinishedSpans ?? 10_000,
    maxMetricPoints: agenticConfig.telemetry.maxMetricPoints ?? 50_000,
    maxHistogramSamples: agenticConfig.telemetry.maxHistogramSamples ?? 1_000,
    maxMetricsCollectorSamples: agenticConfig.telemetry.maxMetricsCollectorSamples ?? 1_000,
  });

  const registry = new ToolRegistry();
  if (fileConfig.setup) {
    await fileConfig.setup({ registry });
  }

  const server = await serveMCP({
    name: fileConfig.name ?? args.name,
    version: fileConfig.version ?? args.version,
    transport: fileConfig.transport ?? args.transport,
    port: fileConfig.port ?? args.port,
    host: fileConfig.host ?? args.host,
    toolRegistry: registry,
    stdio: { handleSignals: false },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`agentic-serve: received ${signal}, shutting down\n`);
    await server.stop();
    await shutdownObservability();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (server.getBaseUrl()) {
    process.stderr.write(`agentic-serve: listening on ${server.getBaseUrl()}\n`);
  } else {
    process.stderr.write('agentic-serve: listening on stdio\n');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentic-serve: ${message}\n`);
  process.exit(1);
});
