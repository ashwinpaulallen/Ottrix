import type { Provider, Type } from '@nestjs/common';
import { ToolNotFoundError, type ToolRegistry } from 'ottrix';
import { OTTRIX_TOOL_REGISTRY } from '../tokens.js';
import type { OttrixToolFactory } from './ottrix-tool.provider.js';

/** Register NestJS tool provider classes on the global tool registry before agents resolve. */
export function createToolProviders(
  toolClasses: Array<Type<OttrixToolFactory>>,
  readyToken: symbol,
): Provider[] {
  if (toolClasses.length === 0) {
    return [];
  }

  const classProviders: Provider[] = toolClasses.map((toolClass) => ({
    provide: toolClass,
    useClass: toolClass,
  }));

  const registrationProvider: Provider = {
    provide: readyToken,
    useFactory: (registry: ToolRegistry, ...factories: OttrixToolFactory[]) => {
      for (const factory of factories) {
        registry.register(factory.createTool());
      }
      return true;
    },
    inject: [OTTRIX_TOOL_REGISTRY, ...toolClasses],
  };

  return [...classProviders, registrationProvider];
}

/** Resolve agent tool references — instances or registered names. */
export function resolveAgentTools(
  tools: readonly unknown[] | undefined,
  toolRegistry: ToolRegistry,
): import('ottrix').BaseTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  if (typeof tools[0] === 'string') {
    return (tools as string[]).map((name) => {
      const tool = toolRegistry.get(name);
      if (!tool) {
        throw new ToolNotFoundError(name);
      }
      return tool;
    });
  }

  return tools as import('ottrix').BaseTool[];
}
