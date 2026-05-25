import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ottrix } from '@ottrix/hono';
import { createExampleSetup } from '../shared/agent.js';

const { agent, registry } = createExampleSetup();

const app = new Hono();
app.route('/chat', ottrix({ agent, registry }));

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log('POST http://localhost:3000/chat  { "message": "Hello" }');
  console.log('GET  http://localhost:3000/chat/stream?message=Hello');
  console.log('GET  http://localhost:3000/chat/health');
});
