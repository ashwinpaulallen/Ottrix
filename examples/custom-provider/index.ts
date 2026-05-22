/**
 * Custom provider example — extends BaseProvider for a hypothetical HTTP API.
 * No network calls are made; responses are synthesized locally.
 */
import {
  Agent,
  BaseProvider,
  type ChatMessage,
  type CompletionParams,
  type CompletionResult,
  type StreamChunk,
} from 'agent-kit';

/** Hypothetical vendor API — plug in real HTTP calls inside `_rawComplete` / `_rawStream`. */
class HypotheticalProvider extends BaseProvider {
  protected async _rawComplete(params: CompletionParams): Promise<CompletionResult> {
    const prompt = lastUserText(params.messages);
    return {
      content: [
        {
          type: 'text',
          text: `[${this.config.defaultModel}] Hypothetical API response for: ${prompt}`,
        },
      ],
      model: this.config.defaultModel,
      usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 },
      stopReason: 'end_turn',
    };
  }

  protected async *_rawStream(params: CompletionParams): AsyncGenerator<StreamChunk> {
    const result = await this._rawComplete(params);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    yield { type: 'text_delta', data: { text } };
    yield { type: 'done', data: { stopReason: result.stopReason, usage: result.usage } };
  }

  protected async _countTokens(messages: ChatMessage[]): Promise<number> {
    return messages.reduce((sum, message) => sum + lastUserText([message]).length / 4, 0);
  }
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

// `HYPOTHETICAL_API_KEY` would be passed to real HTTP headers in production.
const apiKey = process.env.HYPOTHETICAL_API_KEY ?? 'demo-key-not-used';

const provider = new HypotheticalProvider({
  apiKey,
  baseUrl: process.env.HYPOTHETICAL_BASE_URL ?? 'https://api.hypothetical.example/v1',
  defaultModel: process.env.HYPOTHETICAL_MODEL ?? 'hypothetical-large',
});

const agent = new Agent({
  name: 'hypothetical-agent',
  provider,
  systemPrompt: 'You answer via the Hypothetical API.',
});

const result = await agent.run('Explain provider adapters in one sentence.');

console.log('Model:', result.metadata.model ?? process.env.HYPOTHETICAL_MODEL ?? 'hypothetical-large');
console.log('Response:', result.response);
console.log('Tokens:', result.totalTokens);
