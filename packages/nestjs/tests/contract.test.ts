import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Module,
  Options,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Agent } from 'ottrix';
import type { ProviderRegistry } from 'ottrix';
import type { SseEvent } from 'ottrix/http';
import { checkHealth, corsHeaders, extractMessage } from 'ottrix/http';
import {
  createMockAgent,
  createMockProviderRegistry,
} from 'ottrix/testing';
import { runAdapterContractTests } from 'ottrix/testing/contract';
import { InjectAgent } from '../src/decorators.js';
import { OttrixExceptionFilter } from '../src/filters/ottrix-exception.filter.js';
import { InjectionGuard } from '../src/guards/injection.guard.js';
import { createSseStream } from '../src/helpers/sse.js';
import { RunContextInterceptor } from '../src/interceptors/run-context.interceptor.js';
import { agentToken, OTTRIX_INJECTION_GUARD_OPTIONS, OTTRIX_PROVIDER_REGISTRY } from '../src/tokens.js';

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];

  for (const block of body.split('\n\n')) {
    if (!block.trim()) {
      continue;
    }

    if (block.startsWith(':')) {
      events.push({ event: 'comment', data: block.slice(1).trim() });
      continue;
    }

    let eventName = 'message';
    let data = '';
    let id: string | undefined;

    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
    }

    events.push({ event: eventName, data, ...(id ? { id } : {}) });
  }

  return events;
}

function parseJsonBody(body: string): unknown {
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function buildContractModule(options: {
  agent: Agent;
  bodyField?: string;
  injection?: 'block' | 'flag' | false;
  cors?: boolean;
  healthCheck?: boolean;
  streaming?: boolean;
  registry?: ProviderRegistry;
}) {
  const bodyField = options.bodyField ?? 'message';
  const enableCors = options.cors ?? false;
  const enableInjection = options.injection !== false;
  const injectionMode = options.injection === 'flag' ? 'flag' : 'block';

  @Injectable()
  class ContractCorsInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      if (enableCors) {
        const response = context.switchToHttp().getResponse<Response>();
        const request = context.switchToHttp().getRequest<Request>();
        for (const [key, value] of Object.entries(corsHeaders(request.headers.origin))) {
          response.setHeader(key, value);
        }
      }
      return next.handle();
    }
  }

  @Controller()
  @UseInterceptors(RunContextInterceptor, ContractCorsInterceptor)
  @UseFilters(OttrixExceptionFilter)
  class ContractAgentController {
    constructor(
      @InjectAgent('default') private readonly agent: Agent,
      @Inject(OTTRIX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry | null,
    ) {}

    @Post('chat')
    @HttpCode(200)
    async post(@Body() body: unknown) {
      const parsed = extractMessage(body, bodyField);
      if (!parsed.ok) {
        throw new HttpException({ error: parsed.error }, parsed.status);
      }
      return this.agent.run(parsed.message);
    }

    @Sse('stream')
    stream(@Query('message') message: string) {
      const parsed = extractMessage({ message }, 'message');
      if (!parsed.ok) {
        throw new HttpException({ error: parsed.error }, parsed.status);
      }
      return createSseStream(this.agent)(parsed.message);
    }

    @Get('health')
    async health() {
      if (!this.registry) {
        throw new HttpException(
          {
            error: 'Provider registry is required for health checks',
            code: 'missing_registry',
          },
          503,
        );
      }
      return checkHealth(this.registry);
    }

    @Options('chat')
    @HttpCode(204)
    options(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
      if (!enableCors) {
        return;
      }
      for (const [key, value] of Object.entries(corsHeaders(req.headers.origin))) {
        res.setHeader(key, value);
      }
    }
  }

  @Module({
    controllers: [ContractAgentController],
    providers: [
      RunContextInterceptor,
      ContractCorsInterceptor,
      OttrixExceptionFilter,
      { provide: agentToken('default'), useValue: options.agent },
      { provide: OTTRIX_PROVIDER_REGISTRY, useValue: options.registry ?? null },
      ...(enableInjection
        ? [
            {
              provide: OTTRIX_INJECTION_GUARD_OPTIONS,
              useValue: { mode: injectionMode, bodyField },
            },
            { provide: APP_GUARD, useClass: InjectionGuard },
          ]
        : []),
    ],
  })
  class ContractAppModule {}

  return ContractAppModule;
}

runAdapterContractTests({
  createApp: async (options) => {
    const agent = options.agent ?? createMockAgent();
    const ContractAppModule = buildContractModule({
      agent,
      bodyField: options.bodyField,
      injection: options.injection ?? false,
      cors: options.cors ?? false,
      healthCheck: options.healthCheck ?? false,
      streaming: options.streaming ?? true,
      registry: options.registry,
    });

    const app = await NestFactory.create(ContractAppModule, { logger: false });
    await app.init();
    const httpServer = app.getHttpServer() as Server;

    return {
      request: async (method, path, opts) => {
        let req = request(httpServer)[method.toLowerCase() as 'get' | 'post' | 'options'](path);
        if (opts?.headers) {
          for (const [key, value] of Object.entries(opts.headers)) {
            req = req.set(key, value);
          }
        }
        if (opts?.body !== undefined && opts.body !== null) {
          req = req.set('Content-Type', 'application/json').send(opts.body);
        }
        const res = await req;
        return {
          status: res.status,
          body: parseJsonBody(res.text),
          headers: res.headers,
        };
      },
      requestSse: async (path, query) => {
        let req = request(httpServer).get(path);
        if (query) {
          req = req.query(query);
        }
        const res = await req;
        if (res.status >= 400) {
          return { status: res.status, events: [] };
        }
        return { status: res.status, events: parseSseEvents(res.text) };
      },
      close: async () => {
        await app.close();
      },
    };
  },
});

describe('@ottrix/nestjs contract harness', () => {
  it('loads the contract suite', () => {
    expect(runAdapterContractTests).toBeTypeOf('function');
  });

  it('builds a mock registry for health checks', async () => {
    const registry = createMockProviderRegistry({ providers: { primary: 'healthy' } });
    expect(registry.listRegisteredProviders()).toContain('primary');
  });
});
