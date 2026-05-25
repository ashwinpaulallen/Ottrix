import type { JSONSchema7 } from '@ai-sdk/provider';
import { jsonSchema, tool, type Tool } from 'ai';
import { BaseTool, FunctionTool } from 'ottrix';
import type { JSONSchema } from 'ottrix';

type VercelTool = Tool<Record<string, unknown>, unknown>;

/** Convert ottrix tools to Vercel AI SDK tool definitions. */
export function ottrixToolsToVercel(tools: BaseTool[]): Record<string, VercelTool> {
  const result: Record<string, VercelTool> = {};

  for (const ottrixTool of tools) {
    result[ottrixTool.name] = tool({
      description: ottrixTool.description,
      inputSchema: jsonSchema(toJsonSchema7(ottrixTool.inputSchema)),
      execute: async (args: Record<string, unknown>) => {
        const toolResult = await ottrixTool.execute(args);
        if (!toolResult.success) {
          throw new Error(toolResult.error ?? 'Tool execution failed');
        }
        return toolResult.output;
      },
    });
  }

  return result;
}

/** Convert Vercel AI SDK tools into ottrix {@link BaseTool} instances. */
export function vercelToolsToOttrix(tools: Record<string, VercelTool>): BaseTool[] {
  return Object.entries(tools).map(([name, ottrixTool]) => {
    const schema = extractJsonSchema(ottrixTool);
    return new FunctionTool({
      name,
      description: ottrixTool.description ?? name,
      inputSchema: schema,
      execute: async (input: Record<string, unknown>) => {
        if (!ottrixTool.execute) {
          throw new Error(`Tool "${name}" has no execute handler`);
        }
        return ottrixTool.execute(input, {
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

function extractJsonSchema(ottrixTool: VercelTool): JSONSchema {
  const inputSchema = ottrixTool.inputSchema as { jsonSchema?: JSONSchema7 };
  if (inputSchema && typeof inputSchema === 'object' && inputSchema.jsonSchema) {
    return inputSchema.jsonSchema as JSONSchema;
  }
  return { type: 'object', properties: {} };
}
