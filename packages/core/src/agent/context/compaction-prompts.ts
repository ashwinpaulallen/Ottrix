/**
 * Prompt builders for context compaction.
 * Pure functions: same inputs always produce the same string.
 */

export function buildTopicIndexPrompt(
  messagesToFold: Array<{ role: string; content: string }>,
  config: { maxTokens: number },
): string {
  const MAX = config.maxTokens ?? 400;

  return [
    'You are compacting a conversation for a long-running agent.',
    'Extract a concise TOPIC INDEX from the messages below.',
    'Format: one bullet per key topic, decision, or fact established.',
    'Include: decisions made, tools called and their outcomes, facts learned, unresolved questions.',
    'Exclude: greetings, filler, and restated instructions.',
    `Maximum length: ${MAX} tokens.`,
    'Return ONLY the bullet list. No introduction, no preamble, no explanation.',
    '',
    '<messages_to_index>',
    messagesToFold.map((message) => `[${message.role}]: ${message.content}`).join('\n\n'),
    '</messages_to_index>',
  ].join('\n');
}

export function buildProseDigestPrompt(
  messagesToFold: Array<{ role: string; content: string }>,
  topicIndex: string | undefined,
  config: { maxTokens: number },
): string {
  const MAX = config.maxTokens ?? 600;
  const indexSection = topicIndex
    ? `\n<topic_index>\n${topicIndex}\n</topic_index>\n`
    : '';

  return [
    'You are compacting a conversation for a long-running agent.',
    'Write a CONCISE DIGEST of the messages below.',
    "The digest will be injected into the agent's context in place of these messages.",
    'Preserve: key decisions, tool call outcomes, facts established, open questions.',
    'Omit: filler, repetition, meta-commentary about the conversation itself.',
    `Maximum length: ${MAX} tokens.`,
    indexSection,
    'Return ONLY the digest text. No introduction, no labels.',
    '',
    '<messages_to_digest>',
    messagesToFold.map((message) => `[${message.role}]: ${message.content}`).join('\n\n'),
    '</messages_to_digest>',
  ].join('\n');
}

/** One-line outcome for an old tool call. No LLM call. */
export function buildOutcomeSummaryText(toolName: string, resultPreview: string): string {
  return `[Tool '${toolName}' completed — result: ${resultPreview.slice(0, 200)}${resultPreview.length > 200 ? '...' : ''}]`;
}
