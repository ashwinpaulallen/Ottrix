import type { JSONSchema7 } from '@ai-sdk/provider';
import type { CoreTool } from 'ai';
import { jsonSchema } from 'ai';
import { BaseTool, FunctionTool } from 'ottrix';
import type { JSONSchema } from 'ottrix';

/** Convert ottrix tools to Vercel AI SDK {@link CoreTool} definitions. */
export function ottrixToolsToVercel(tools: BaseTool[]): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {};

  for (const ottrixTool of tools) {
    result[ottrixTool.name] = {
      description: ottrixTool.description,
      parameters: jsonSchema(toJsonSchema7(ottrixTool.inputSchema)),
      execute: async (args: Record<string, unknown>) => {
        const toolResult = await ottrixTool.execute(args);
        if (!toolResult.success) {
          throw new Error(toolResult.error ?? 'Tool execution failed');
        }
        return toolResult.output;
      },
    };
  }

  return result;
}

/** Convert Vercel AI SDK tools into ottrix {@link BaseTool} instances. */
export function vercelToolsToOttrix(tools: Record<string, CoreTool>): BaseTool[] {
  return Object.entries(tools).map(([name, tool]) => {
    const schema = extractJsonSchema(tool);
    return new FunctionTool({
      name,
      description: tool.description ?? name,
      inputSchema: schema,
      execute: async (input: Record<string, unknown>) => {
        if (!tool.execute) {
          throw new Error(`Tool "${name}" has no execute handler`);
        }
        return tool.execute(input, {
          toolCallId: `${name}-call`,
          messages: [],
        });
      },
    });
  });
}

function toJsonSchema7(schema: JSONSchema): JSONSchema7 {
  return schema as JSONSchema7;
}

function extractJsonSchema(tool: CoreTool): JSONSchema {
  const parameters = tool.parameters as { jsonSchema?: JSONSchema7 };
  if (parameters && typeof parameters === 'object' && 'jsonSchema' in parameters && parameters.jsonSchema) {
    return parameters.jsonSchema as JSONSchema;
  }
  return { type: 'object', properties: {} };
}
