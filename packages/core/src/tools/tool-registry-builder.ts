import type { BaseTool } from './tool.js';

/** A typed tool registry with a frozen list of tool names. */
export type ToolRegistryDefinition<T extends Record<string, BaseTool>> = T & {
  readonly names: readonly (keyof T & string)[];
};

/** Union of tool names from a {@link defineToolRegistry} result. */
export type ToolNames<T extends Record<string, BaseTool>> = keyof T & string;

/**
 * Define a typed tool registry for compile-time-safe tool name references.
 *
 * @example
 * ```ts
 * const tools = defineToolRegistry({
 *   searchProducts: createTool({ name: 'searchProducts', ... }),
 *   getProductDetails: createTool({ name: 'getProductDetails', ... }),
 * });
 *
 * createAgent({ tools: pickTools(tools, 'searchProducts') });
 * ```
 */
export function defineToolRegistry<T extends Record<string, BaseTool>>(
  tools: T,
): ToolRegistryDefinition<T> {
  const names = Object.freeze(Object.keys(tools));
  return Object.assign(tools, { names });
}

/**
 * Pick tools from a typed registry by name.
 *
 * @throws When a name is missing from the registry.
 */
export function pickTools<T extends Record<string, BaseTool>>(
  registry: T,
  ...names: ToolNames<T>[]
): BaseTool[] {
  return names.map((name) => {
    const tool = registry[name];
    if (!tool) {
      throw new Error(`Tool "${String(name)}" is not defined in the registry`);
    }
    return tool;
  });
}

/**
 * Type guard for tool name arrays used in agent configuration.
 */
export function isToolNameArray(tools: readonly unknown[]): tools is readonly string[] {
  return tools.length > 0 && typeof tools[0] === 'string';
}
