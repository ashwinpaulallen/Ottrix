import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
await app.listen(3000);
console.log('POST http://localhost:3000/chat  { "message": "Hello" }');
console.log('GET  http://localhost:3000/chat/stream?message=Hello');
