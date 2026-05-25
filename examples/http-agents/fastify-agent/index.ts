import Fastify from 'fastify';
import { agentRoutes, ottrixPlugin } from '@ottrix/fastify';
import { createExampleSetup } from '../shared/agent.js';

const { agent, registry } = createExampleSetup();

const app = Fastify();
await app.register(ottrixPlugin);
await app.register(agentRoutes, { prefix: '/chat', agent, registry });
await app.listen({ port: 3000 });

console.log('POST http://localhost:3000/chat  { "message": "Hello" }');
console.log('GET  http://localhost:3000/chat/stream?message=Hello');
console.log('GET  http://localhost:3000/chat/health');
