/**
 * Minimal CLI chatbot — streams tokens to stdout.
 * Mock mode: npm start
 * Live mode: ANTHROPIC_API_KEY=sk-... AGENTIC_PROVIDER=anthropic npm start
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createChatAgent } from './agent.js';

const rl = readline.createInterface({ input, output });
const agent = createChatAgent();

console.log('agentic-fabric chatbot (type "exit" to quit)\n');

while (true) {
  const line = (await rl.question('You: ')).trim();
  if (!line || line.toLowerCase() === 'exit') break;

  process.stdout.write('AI: ');
  for await (const event of agent.stream(line)) {
    if (event.type === 'text') {
      process.stdout.write(String((event.data as { text: string }).text));
    }
    if (event.type === 'done') {
      process.stdout.write('\n\n');
    }
  }
}

rl.close();
