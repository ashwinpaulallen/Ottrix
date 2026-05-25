import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Options,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type Type,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import { checkHealth, corsHeaders, extractMessage } from 'ottrix/http';
import { InjectAgent } from '../decorators.js';
import { OttrixExceptionFilter } from '../filters/ottrix-exception.filter.js';
import { InjectionGuard } from '../guards/injection.guard.js';
import { createSseStream, type SseMessageEvent } from '../helpers/sse.js';
import { RunContextInterceptor } from '../interceptors/run-context.interceptor.js';
import { TelemetryInterceptor } from '../interceptors/telemetry.interceptor.js';
import type { ResolvedOttrixHttpOptions } from '../interfaces.js';
import { OTTRIX_HTTP_OPTIONS, OTTRIX_PROVIDER_REGISTRY } from '../tokens.js';

/** Creates a zero-config Ottrix HTTP controller at the given route prefix. */
export function createOttrixController(path = 'chat'): Type<unknown> {
  @Controller(path)
  @UseInterceptors(RunContextInterceptor, TelemetryInterceptor)
  @UseGuards(InjectionGuard)
  @UseFilters(OttrixExceptionFilter)
  class OttrixControllerImpl {
    constructor(
      @InjectAgent('default') private readonly agent: Agent,
      @Inject(OTTRIX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
      @Optional()
      @Inject(OTTRIX_HTTP_OPTIONS)
      private readonly httpOptions?: ResolvedOttrixHttpOptions,
    ) {}

    @Post()
    @HttpCode(200)
    async run(@Body() body: unknown) {
      const extracted = extractMessage(body);
      if (!extracted.ok) {
        throw new HttpException({ error: extracted.error }, extracted.status);
      }
      return this.agent.run(extracted.message);
    }

    @Sse('stream')
    stream(@Query('message') message: string): Observable<SseMessageEvent> {
      const extracted = extractMessage({ message }, 'message');
      if (!extracted.ok) {
        throw new HttpException({ error: extracted.error }, extracted.status);
      }
      return createSseStream(this.agent)(extracted.message);
    }

    @Get('health')
    async health() {
      return checkHealth(this.registry);
    }

    @Options()
    @HttpCode(204)
    options(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
      if (this.httpOptions?.cors === false) {
        return;
      }
      for (const [key, value] of Object.entries(corsHeaders(req.headers.origin))) {
        res.setHeader(key, value);
      }
    }
  }

  return OttrixControllerImpl;
}

/** Pre-built zero-config controller mounted at `/chat`. */
export const OttrixController = createOttrixController('chat');
