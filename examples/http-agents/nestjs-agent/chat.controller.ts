import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
  Sse,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  createSseStream,
  InjectAgent,
  InjectionGuard,
  OTTRIX_PROVIDER_REGISTRY,
  OttrixExceptionFilter,
  RunContextInterceptor,
  TelemetryInterceptor,
} from '@ottrix/nestjs';
import { checkHealth, extractMessage } from 'ottrix/http';
import type { Agent, ProviderRegistry } from 'ottrix';

@Controller('chat')
@UseInterceptors(RunContextInterceptor, TelemetryInterceptor)
@UseGuards(InjectionGuard)
@UseFilters(OttrixExceptionFilter)
export class ChatController {
  constructor(
    @InjectAgent('default') private readonly agent: Agent,
    @Inject(OTTRIX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  @Post()
  @HttpCode(200)
  async run(@Body() body: unknown) {
    const extracted = extractMessage(body);
    if (!extracted.ok) throw new HttpException({ error: extracted.error }, extracted.status);
    return this.agent.run(extracted.message);
  }

  @Sse('stream')
  stream(@Query('message') message: string) {
    const extracted = extractMessage({ message }, 'message');
    if (!extracted.ok) throw new HttpException({ error: extracted.error }, extracted.status);
    return createSseStream(this.agent)(extracted.message);
  }

  @Get('health')
  async health() {
    return checkHealth(this.registry);
  }
}
