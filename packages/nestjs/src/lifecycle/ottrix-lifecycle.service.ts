import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getLogger, getTelemetry, type TraceExporter } from 'ottrix';
import type { OttrixModuleOptions } from '../interfaces.js';
import { OTTRIX_MODULE_OPTIONS, OTTRIX_PROVIDER_NAMES } from '../tokens.js';
import { configureTelemetry } from '../setup/configure-telemetry.js';

/** Validates Ottrix config and manages telemetry flush on shutdown. */
@Injectable()
export class OttrixLifecycleService implements OnModuleInit, OnModuleDestroy {
  private traceExporter?: TraceExporter;
  private readonly logger = getLogger().child({ integration: 'nestjs' });

  constructor(
    @Inject(OTTRIX_MODULE_OPTIONS) private readonly options: OttrixModuleOptions,
    @Inject(OTTRIX_PROVIDER_NAMES) private readonly providerNames: string[],
  ) {}

  onModuleInit(): void {
    this.traceExporter = configureTelemetry(this.options.telemetry);
    this.logger.info('Ottrix module initialized', {
      providers: this.providerNames,
      fallbackChain: this.options.providers.chain,
      telemetry: this.options.telemetry?.exporter ?? 'none',
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.traceExporter) {
      await this.traceExporter.flush();
      return;
    }
    await getTelemetry().shutdown();
  }
}
