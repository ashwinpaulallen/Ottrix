import type { BaseTool } from 'ottrix';

/** Contract for NestJS providers that expose an Ottrix tool. */
export interface OttrixToolFactory {
  /** Build the tool instance to register on the global {@link ToolRegistry}. */
  createTool(): BaseTool;
}

/** Optional base class for {@link OttrixTool} providers. */
export abstract class OttrixToolProvider implements OttrixToolFactory {
  abstract createTool(): BaseTool;
}
