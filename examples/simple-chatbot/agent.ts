import { Agent, createAgent } from 'agent-kit';
import { DemoProvider } from '../shared/demo-provider.js';

/** Real Anthropic when `ANTHROPIC_API_KEY` is set; otherwise deterministic demo provider. */
export function createChatAgent(): Agent {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return createAgent({
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.AGENTIC_MODEL,
      systemPrompt: 'You are a concise, friendly assistant.',
      telemetry: false,
      guardrails: false,
      memory: false,
    });
  }

  return new Agent({
    name: 'chatbot',
    provider: new DemoProvider(),
    systemPrompt: 'You are a concise, friendly assistant.',
  });
}
