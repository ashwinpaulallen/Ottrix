import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Module,
  Options,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import request from 'supertest';
import type { Agent, ProviderRegistry } from 'ottrix';
import type { SseEvent } from 'ottrix/http';
import { checkHealth, corsHeaders, extractMessage } from 'ottrix/http';
import { InjectAgent } from '../decorators.js';
import { OttrixExceptionFilter } from '../filters/ottrix-exception.filter.js';
import { InjectionGuard } from '../guards/injection.guard.js';
import { createSseStream } from '../helpers/sse.js';
import { RunContextInterceptor } from '../interceptors/run-context.interceptor.js';
import { agentToken, OTTRIX_INJECTION_GUARD_OPTIONS, OTTRIX_PROVIDER_REGISTRY } from '../tokens.js';

/** HTTP harness for adapter contract and parity tests. */
export interface ContractTestHarness {
  request: (
    method: string,
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
    },
  ) => Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }>;
  requestSse: (
    path: string,
    query?: Record<string, string>,
  ) => Promise<{
    events: SseEvent[];
    status: number;
  }>;
  close: () => Promise<void>;
}

/** Options for {@link createContractHarness}. */
export interface ContractHarnessOptions {
  agent: Agent;
  injection?: 'block' | 'flag' | false;
  cors?: boolean;
  healthCheck?: boolean;
  registry?: ProviderRegistry;
  bodyField?: string;
}

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

function buildContractModule(options: ContractHarnessOptions) {
  const bodyField = options.bodyField ?? 'message';
  const enableCors = options.cors ?? false;
  const enableInjection = options.injection !== false;
  const injectionMode = options.injection === 'flag' ? 'flag' : 'block';

  @Injectable()
  class ContractCorsInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      if (enableCors) {
        const response = context.switchToHttp().getResponse<Response>();
        const req = context.switchToHttp().getRequest<Request>();
        for (const [key, value] of Object.entries(corsHeaders(req.headers.origin))) {
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

/** Create a NestJS app harness matching the shared ottrix adapter contract routes. */
export async function createContractHarness(
  options: ContractHarnessOptions,
): Promise<ContractTestHarness> {
  const ContractAppModule = buildContractModule(options);
  const app = await NestFactory.create(ContractAppModule, { logger: false });
  await app.init();

  return {
    request: async (method, path, opts) => {
      let req = request(app.getHttpServer())[method.toLowerCase() as 'get' | 'post' | 'options'](path);
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
        headers: res.headers as Record<string, string>,
      };
    },
    requestSse: async (path, query) => {
      let req = request(app.getHttpServer()).get(path);
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
}
