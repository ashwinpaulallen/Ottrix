import { DynamicStructuredTool, type StructuredTool } from '@langchain/core/tools';
import { BaseTool, FunctionTool } from 'ottrix';
import type { JSONSchema } from 'ottrix';

/** Convert ottrix tools to LangChain {@link StructuredTool} instances. */
export function ottrixToolsToLangChain(tools: BaseTool[]): StructuredTool[] {
  return tools.map(
    (tool) =>
      new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema: tool.inputSchema as JSONSchema,
        func: async (input: Record<string, unknown>) => {
          const result = await tool.execute(input);
          if (!result.success) {
            throw new Error(result.error ?? 'Tool execution failed');
          }
          return result.output;
        },
      }),
  );
}

/** Convert LangChain tools into ottrix {@link BaseTool} instances. */
export function langChainToolsToOttrix(tools: StructuredTool[]): BaseTool[] {
  return tools.map((tool) => {
    const schema = extractSchema(tool.schema);
    return new FunctionTool({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: schema,
      execute: async (input: Record<string, unknown>) => tool.invoke(input),
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
