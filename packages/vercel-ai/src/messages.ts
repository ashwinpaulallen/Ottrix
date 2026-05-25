import type {
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultOutput,
} from '@ai-sdk/provider';
import type { ChatMessage, ContentBlock, JSONSchema, ToolDefinition } from 'ottrix';

/** Convert a Vercel AI SDK prompt to ottrix {@link ChatMessage} list. */
export function vercelPromptToOttrixMessages(prompt: LanguageModelV2Prompt): ChatMessage[] {
  return prompt.map(convertMessage);
}

/** Extract ottrix tool definitions from Vercel call options. */
export function vercelToolsToOttrixDefinitions(
  options: LanguageModelV2CallOptions,
): ToolDefinition[] | undefined {
  if (!options.tools?.length) {
    return undefined;
  }

  return options.tools
    .filter((tool): tool is LanguageModelV2FunctionTool => tool.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as JSONSchema,
    }));
}

/** Resolve ottrix response format from Vercel call options. */
export function vercelResponseFormat(
  options: LanguageModelV2CallOptions,
): 'json' | 'text' | undefined {
  if (options.responseFormat?.type === 'json') {
    return 'json';
  }
  return undefined;
}

function convertMessage(message: LanguageModelV2Prompt[number]): ChatMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return {
        role: 'user',
        content: message.content.map((part) => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text };
          }
          return filePartToText(part.data, part.mediaType, part.filename);
        }),
      };
    case 'assistant': {
      const content: ContentBlock[] = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: part.toolCallId,
            name: part.toolName,
            input: normalizeToolArgs(part.input),
          });
        } else if (part.type === 'reasoning') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'file') {
          content.push(filePartToText(part.data, part.mediaType, part.filename));
        } else if (part.type === 'tool-result') {
          content.push({
            type: 'tool_result',
            tool_use_id: part.toolCallId,
            content: serializeToolResultOutput(part.output),
          });
        }
      }
      return { role: 'assistant', content };
    }
    case 'tool':
      return {
        role: 'tool',
        content: message.content.map((part) => ({
          type: 'tool_result' as const,
          tool_use_id: part.toolCallId,
          content: serializeToolResultOutput(part.output),
        })),
      };
    default:
      return { role: 'user', content: '' };
  }
}

function filePartToText(data: Uint8Array | string | URL, mimeType: string, filename?: string): ContentBlock {
  const label = filename ? `${filename} (${mimeType})` : mimeType;
  if (data instanceof URL) {
    return { type: 'text', text: `[file: ${label}] ${data.toString()}` };
  }
  if (typeof data === 'string') {
    return { type: 'text', text: `[file: ${label}] ${data}` };
  }
  return { type: 'text', text: `[file: ${label}] ${Buffer.from(data).toString('base64')}` };
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: args };
    }
  }
  return {};
}

function serializeToolResultOutput(output: LanguageModelV2ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'content':
      return output.value
        .map((part) => (part.type === 'text' ? part.text : `[media:${part.mediaType}]`))
        .join('');
    default:
      return JSON.stringify(output);
  }
}

/** Extract assistant text from ottrix content blocks. */
export function ottrixContentToText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Extract tool calls from ottrix content blocks. */
export function ottrixContentToToolCalls(
  content: ContentBlock[],
): Array<{ toolCallId: string; toolName: string; input: string }> {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({
      toolCallId: block.id,
      toolName: block.name,
      input: JSON.stringify(block.input ?? {}),
    }));
}
