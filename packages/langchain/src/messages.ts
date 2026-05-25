import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { ChatMessage, CompletionResult, ContentBlock, JSONSchema, ToolDefinition } from 'ottrix';

/** Convert a single LangChain message to ottrix format. */
export function langChainMessageToOttrix(message: BaseMessage): ChatMessage {
  return langChainMessagesToOttrix([message])[0]!;
}

/** Convert LangChain messages to ottrix {@link ChatMessage} format. */
export function langChainMessagesToOttrix(messages: BaseMessage[]): ChatMessage[] {
  return messages.map(convertLangChainMessage);
}

/** Convert ottrix messages to LangChain {@link BaseMessage} instances. */
export function ottrixMessagesToLangChain(messages: ChatMessage[]): BaseMessage[] {
  return messages.map(ottrixMessageToLangChain);
}

/** Map an ottrix completion result to a LangChain {@link AIMessage}. */
export function ottrixCompletionToAIMessage(result: CompletionResult): AIMessage {
  const text = ottrixContentToText(result.content);
  const toolCalls = ottrixContentToToolCalls(result.content);

  return new AIMessage({
    content: text,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    response_metadata: {
      model: result.model,
      stopReason: result.stopReason,
      usage: result.usage,
    },
  });
}

function convertLangChainMessage(message: BaseMessage): ChatMessage {
  const type = message._getType();

  if (type === 'system') {
    return { role: 'system', content: contentToString(message.content) };
  }

  if (type === 'human') {
    return { role: 'user', content: contentToBlocks(message.content) };
  }

  if (type === 'ai') {
    const ai = message as AIMessage;
    const blocks: ContentBlock[] = [];
    const text = contentToString(ai.content);
    if (text) {
      blocks.push({ type: 'text', text });
    }
    for (const call of ai.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id ?? `${call.name}-${blocks.length}`,
        name: call.name,
        input: call.args ?? {},
      });
    }
    return { role: 'assistant', content: blocks.length > 0 ? blocks : '' };
  }

  if (type === 'tool') {
    const tool = message as ToolMessage;
    return {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.tool_call_id,
          content: contentToString(tool.content),
        },
      ],
    };
  }

  return { role: 'user', content: contentToString(message.content) };
}

function ottrixMessageToLangChain(message: ChatMessage): BaseMessage {
  switch (message.role) {
    case 'system':
      return new SystemMessage(typeof message.content === 'string' ? message.content : contentToString(message.content));
    case 'user':
      return new HumanMessage(
        typeof message.content === 'string' ? message.content : contentToString(message.content),
      );
    case 'assistant': {
      if (typeof message.content === 'string') {
        return new AIMessage(message.content);
      }
      const text = ottrixContentToText(message.content);
      const toolCalls = ottrixContentToToolCalls(message.content);
      return new AIMessage({
        content: text,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
    case 'tool': {
      const blocks = typeof message.content === 'string' ? [] : message.content;
      const result = blocks.find((block) => block.type === 'tool_result');
      return new ToolMessage({
        content: result
          ? typeof result.content === 'string'
            ? result.content
            : contentToString(result.content)
          : contentToString(message.content),
        tool_call_id: result?.tool_use_id ?? 'unknown',
      });
    }
    default:
      return new HumanMessage(contentToString(message.content));
  }
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? '' : String(content);
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && 'type' in part) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        if (part.type === 'image_url' && 'image_url' in part) {
          const url = (part as { image_url?: { url?: string } }).image_url?.url;
          return url ? `[image:${url}]` : '[image]';
        }
      }
      return JSON.stringify(part);
    })
    .join('');
}

function contentToBlocks(content: unknown): string | ContentBlock[] {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? '' : String(content);
  }
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
      blocks.push({ type: 'text', text: String(part.text) });
    }
  }
  return blocks.length > 0 ? blocks : contentToString(content);
}

function ottrixContentToText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function ottrixContentToToolCalls(content: ContentBlock[]): ToolCall[] {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: block.input ?? {},
      type: 'tool_call' as const,
    }));
}

/** Convert LangChain bind-tools inputs to ottrix tool definitions. */
export function bindToolsToOttrixDefinitions(tools: unknown[]): ToolDefinition[] {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') {
      return [];
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name === 'string' && record.schema) {
      return [
        {
          name: record.name,
          description: typeof record.description === 'string' ? record.description : record.name,
          inputSchema: extractSchema(record.schema) as JSONSchema,
        },
      ];
    }
    if (record.type === 'function' && record.function && typeof record.function === 'object') {
      const fn = record.function as Record<string, unknown>;
      if (typeof fn.name === 'string') {
        return [
          {
            name: fn.name,
            description: typeof fn.description === 'string' ? fn.description : fn.name,
            inputSchema: (fn.parameters ?? { type: 'object', properties: {} }) as JSONSchema,
          },
        ];
      }
    }
    return [];
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
