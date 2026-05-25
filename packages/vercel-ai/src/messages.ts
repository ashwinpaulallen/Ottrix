import type {
  LanguageModelV1CallOptions,
  LanguageModelV1FunctionTool,
  LanguageModelV1Prompt,
} from '@ai-sdk/provider';
import type { ChatMessage, ContentBlock, JSONSchema, ToolDefinition } from 'ottrix';

/** Convert a Vercel AI SDK prompt to ottrix {@link ChatMessage} list. */
export function vercelPromptToOttrixMessages(prompt: LanguageModelV1Prompt): ChatMessage[] {
  return prompt.map(convertMessage);
}

/** Extract ottrix tool definitions from Vercel call options. */
export function vercelToolsToOttrixDefinitions(
  options: LanguageModelV1CallOptions,
): ToolDefinition[] | undefined {
  const mode = options.mode;
  if (mode.type === 'regular' && mode.tools?.length) {
    return mode.tools
      .filter((tool): tool is LanguageModelV1FunctionTool => tool.type === 'function')
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.parameters as JSONSchema,
      }));
  }
  if (mode.type === 'object-tool') {
    return [
      {
        name: mode.tool.name,
        description: mode.tool.description ?? '',
        inputSchema: mode.tool.parameters as JSONSchema,
      },
    ];
  }
  return undefined;
}

/** Resolve ottrix response format from Vercel call options. */
export function vercelResponseFormat(
  options: LanguageModelV1CallOptions,
): 'json' | 'text' | undefined {
  if (options.mode.type === 'object-json') {
    return 'json';
  }
  return undefined;
}

function convertMessage(message: LanguageModelV1Prompt[number]): ChatMessage {
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
          if (part.type === 'image') {
            return imagePartToBlock(part.image, part.mimeType);
          }
          return filePartToText(part.data, part.mimeType, part.filename);
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
            input: normalizeToolArgs(part.args),
          });
        } else if (part.type === 'reasoning') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'redacted-reasoning') {
          content.push({ type: 'text', text: '[redacted]' });
        } else {
          content.push({ type: 'text', text: `[unsupported part: ${part.type}]` });
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
          content: serializeToolResult(part.result, part.isError),
        })),
      };
    default:
      return { role: 'user', content: '' };
  }
}

function imagePartToBlock(image: Uint8Array | URL, mimeType?: string): ContentBlock {
  if (image instanceof URL) {
    return {
      type: 'image',
      source: {
        type: 'url',
        media_type: mimeType ?? 'image/jpeg',
        data: image.toString(),
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeType ?? 'image/jpeg',
      data: Buffer.from(image).toString('base64'),
    },
  };
}

function filePartToText(data: string | URL, mimeType: string, filename?: string): ContentBlock {
  const label = filename ? `${filename} (${mimeType})` : mimeType;
  const payload = data instanceof URL ? data.toString() : data;
  return { type: 'text', text: `[file: ${label}] ${payload}` };
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

function serializeToolResult(result: unknown, isError?: boolean): string {
  const prefix = isError ? 'Error: ' : '';
  if (typeof result === 'string') {
    return `${prefix}${result}`;
  }
  return `${prefix}${JSON.stringify(result)}`;
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
): Array<{ toolCallType: 'function'; toolCallId: string; toolName: string; args: string }> {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({
      toolCallType: 'function' as const,
      toolCallId: block.id,
      toolName: block.name,
      args: JSON.stringify(block.input ?? {}),
    }));
}
