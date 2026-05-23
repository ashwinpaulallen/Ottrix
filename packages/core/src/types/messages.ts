/**
 * Role of a participant in a chat conversation.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Plain-text segment within a multimodal message.
 */
export interface TextBlock {
  /** Discriminator for content block unions. */
  type: 'text';
  /** UTF-8 text payload. */
  text: string;
}

/**
 * Image source encoded as base64 or referenced by URL.
 */
export interface ImageSource {
  /** How the image bytes are supplied. */
  type: 'base64' | 'url';
  /** MIME type (e.g. `image/png`, `image/jpeg`). */
  media_type: string;
  /** Base64 payload or URL string, depending on `type`. */
  data: string;
}

/**
 * Image segment within a multimodal message.
 */
export interface ImageBlock {
  /** Discriminator for content block unions. */
  type: 'image';
  /** Image location and encoding metadata. */
  source: ImageSource;
}

/**
 * Model-initiated request to invoke a tool.
 */
export interface ToolUseBlock {
  /** Discriminator for content block unions. */
  type: 'tool_use';
  /** Unique identifier for this tool invocation (provider-assigned). */
  id: string;
  /** Registered tool name to execute. */
  name: string;
  /** Parsed tool arguments from the model. */
  input: Record<string, unknown>;
}

/**
 * Result returned for a prior {@link ToolUseBlock}.
 */
export interface ToolResultBlock {
  /** Discriminator for content block unions. */
  type: 'tool_result';
  /** ID of the {@link ToolUseBlock} this result corresponds to. */
  tool_use_id: string;
  /** Tool output as plain text or structured blocks. */
  content: string | ContentBlock[];
}

/**
 * Union of all structured content blocks supported in messages.
 */
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

/**
 * A single message in a conversation thread.
 *
 * @typeParam TMeta - Optional application-specific metadata attached to the message.
 */
export interface ChatMessage<TMeta = undefined> {
  /** Speaker role for this turn. */
  role: ChatRole;
  /** Plain string or multimodal block array. */
  content: string | ContentBlock[];
  /** Optional metadata (e.g. tool name, trace IDs). */
  metadata?: TMeta;
}
