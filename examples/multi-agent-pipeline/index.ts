/**
 * Three-agent sequential pipeline: researcher → analyzer → writer.
 * Uses demo providers so no API keys are required.
 */
import { Agent, SequentialWorkflow } from 'ottrix';
import { DemoProvider } from '../shared/demo-provider.js';

function stepAgent(name: string, reply: string): Agent {
  return new Agent({
    name,
    provider: new DemoProvider().textReply(reply),
    systemPrompt: `You are the ${name} stage of a content pipeline.`,
  });
}

const researcher = stepAgent(
  'researcher',
  'Research notes: Multi-agent systems divide work across specialized agents with orchestration.',
);
const analyzer = stepAgent(
  'analyzer',
  'Analysis: Key themes are specialization, hand-offs, and shared context between agents.',
);
const writer = stepAgent(
  'writer',
  'Final article: Coordinated agents outperform monolithic prompts when tasks have clear phases.',
);

const workflow = new SequentialWorkflow([
  {
    agent: researcher,
    inputMapper: ({ originalInput }) => `Gather background on: ${originalInput}`,
  },
  {
    agent: analyzer,
    inputMapper: (_ctx, prev) => `Analyze these notes:\n${prev?.response ?? ''}`,
  },
  {
    agent: writer,
    inputMapper: (_ctx, prev) => `Write a short article from:\n${prev?.response ?? ''}`,
  },
]);

const topic = process.argv[2] ?? 'multi-agent AI pipelines';
console.log(`Topic: ${topic}\n`);

const output = await workflow.run(topic);

for (const [index, step] of output.steps.entries()) {
  console.log(`--- Step ${index + 1}: ${step.agentName} ---`);
  console.log(`Input: ${step.input.slice(0, 120)}${step.input.length > 120 ? '…' : ''}`);
  console.log(`Output: ${step.result.response}\n`);
}

console.log('=== Final ===');
console.log(output.finalResult.response);
