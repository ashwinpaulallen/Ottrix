import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OtelExporter } from 'ottrix/exporters/otel';
import {
  getLogger,
  getTelemetry,
  setTelemetry,
  shutdownObservability,
  Telemetry,
  LangfuseExporter,
  TraceConsoleExporter,
  WebhookExporter,
  type TraceExporter,
} from 'ottrix/observability';
import type { OttrixModuleOptions } from '../interfaces.js';
import { OTTRIX_MODULE_OPTIONS } from '../tokens.js';

/** NestJS wrapper around Ottrix global {@link Telemetry}. */
@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private telemetry: Telemetry;
  private traceExporters: TraceExporter[] = [];
  private readonly logger = getLogger().child({ integration: 'nestjs', service: 'telemetry' });

  constructor(@Inject(OTTRIX_MODULE_OPTIONS) private readonly options: OttrixModuleOptions) {
    this.telemetry = getTelemetry();
  }

  onModuleInit(): void {
    this.configureExporters();
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
    await shutdownObservability();
  }

  /** Underlying Ottrix telemetry instance. */
  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  /** Flush all registered trace exporters. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.traceExporters.map((exporter) => exporter.flush()));
  }

  private configureExporters(): void {
    const config = this.options.telemetry;
    if (!config) {
      return;
    }

    const exporter = this.createExporter(config);
    if (!exporter) {
      return;
    }

    this.traceExporters.push(exporter);
    this.telemetry.addExporter(exporter);
    setTelemetry(this.telemetry);
  }

  private createExporter(config: NonNullable<OttrixModuleOptions['telemetry']>): TraceExporter | undefined {
    switch (config.exporter) {
      case 'console':
        return new TraceConsoleExporter();
      case 'langfuse': {
        if (!config.langfuse?.publicKey || !config.langfuse.secretKey) {
          this.logger.warn('Langfuse exporter requires publicKey and secretKey');
          return undefined;
        }
        return new LangfuseExporter({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
        });
      }
      case 'otel': {
        if (!config.otel?.endpoint) {
          this.logger.warn('OTEL exporter requires otel.endpoint');
          return undefined;
        }
        return new OtelExporter({
          endpoint: config.otel.endpoint,
          protocol: config.otel.protocol ?? 'http',
          headers: config.otel.headers,
          serviceName: config.otel.serviceName,
        });
      }
      case 'webhook': {
        if (!config.webhook?.url) {
          this.logger.warn('Webhook exporter requires webhook.url');
          return undefined;
        }
        return new WebhookExporter({
          url: config.webhook.url,
          headers: config.webhook.headers,
        });
      }
      default:
        this.logger.warn('Unknown telemetry exporter configured', {
          exporter: String(config.exporter),
        });
        return undefined;
    }
  }
}
