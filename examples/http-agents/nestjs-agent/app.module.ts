import { Module } from '@nestjs/common';
import { OttrixModule } from '@ottrix/nestjs';
import { ChatController } from './chat.controller.js';

@Module({
  imports: [
    OttrixModule.forRoot({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
      http: true,
    }),
    OttrixModule.forFeature({
      agents: [{ name: 'default', systemPrompt: 'You are a helpful assistant.' }],
    }),
  ],
  controllers: [ChatController],
})
export class AppModule {}
