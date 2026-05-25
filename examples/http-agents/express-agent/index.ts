import express from 'express';
import { createAgentRouter, gracefulShutdown } from '@ottrix/express';
import { createExampleSetup } from '../shared/agent.js';

const { agent, registry } = createExampleSetup();

const app = express();
app.use(express.json());
app.use('/chat', createAgentRouter({ agent, registry }));

const server = app.listen(3000, () => {
  console.log('POST http://localhost:3000/chat  { "message": "Hello" }');
  console.log('GET  http://localhost:3000/chat/stream?message=Hello');
  console.log('GET  http://localhost:3000/chat/health');
});

gracefulShutdown(server);
