import { createTool, type Tool } from '@mastra/core/tools';
import type { JSONSchema7 } from 'json-schema';
import { BaseTool, FunctionTool } from 'ottrix';
import type { JSONSchema } from 'ottrix';

/** Mastra tool instance produced by {@link ottrixToolsToMastra}. */
export type MastraTool = Tool;

/** Convert ottrix tools into Mastra {@link Tool} instances. */
export function ottrixToolsToMastra(tools: BaseTool[]): MastraTool[] {
  return tools.map((tool) =>
    createTool({
      id: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JSONSchema7,
      execute: async (inputData: unknown) => {
        const input = inputData as Record<string, unknown>;
        const result = await tool.execute(input);
        if (!result.success) {
          throw new Error(result.error ?? 'Tool execution failed');
        }
        return result.output;
      },
    }),
  );
}

/** Convert Mastra tools into ottrix {@link BaseTool} instances. */
export function mastraToolsToOttrix(tools: MastraTool[]): BaseTool[] {
  return tools.map((tool) => {
    const schema = extractSchema(tool.inputSchema);
    return new FunctionTool({
      name: tool.id,
      description: tool.description ?? tool.id,
      inputSchema: schema,
      execute: async (input: Record<string, unknown>) => {
        if (!tool.execute) {
          throw new Error(`Tool "${tool.id}" has no execute handler`);
        }
        return tool.execute(input, {});
      },
    });
  });
}

function extractSchema(schema: unknown): JSONSchema {
  if (schema && typeof schema === 'object') {
    const record = schema as Record<string, unknown>;
    if ('jsonSchema' in record && record.jsonSchema && typeof record.jsonSchema === 'object') {
      return record.jsonSchema as JSONSchema;
    }
    return schema as JSONSchema;
  }
  return { type: 'object', properties: {} };
}
