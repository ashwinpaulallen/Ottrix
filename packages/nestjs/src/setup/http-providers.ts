import type { Provider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { OttrixHttpOptions, ResolvedOttrixHttpOptions } from '../interfaces.js';
import {
  OTTRIX_HTTP_OPTIONS,
  OTTRIX_INJECTION_GUARD_OPTIONS,
  OTTRIX_RUN_CONTEXT_OPTIONS,
} from '../tokens.js';
import { RunContextInterceptor } from '../interceptors/run-context.interceptor.js';
import { TelemetryInterceptor } from '../interceptors/telemetry.interceptor.js';
import { InjectionGuard } from '../guards/injection.guard.js';

const DEFAULT_HTTP: ResolvedOttrixHttpOptions = {
  runContext: true,
  telemetry: true,
  injectionGuard: false,
  cors: true,
};

/** Resolve {@link OttrixHttpOptions} into concrete feature flags. */
export function resolveHttpOptions(http?: OttrixHttpOptions): ResolvedOttrixHttpOptions {
  if (http === false) {
    return { runContext: false, telemetry: false, injectionGuard: false, cors: false };
  }

  if (http === true) {
    return { runContext: true, telemetry: true, injectionGuard: true, cors: true };
  }

  if (http === undefined) {
    return { ...DEFAULT_HTTP };
  }

  return {
    runContext: http.runContext ?? DEFAULT_HTTP.runContext,
    telemetry: http.telemetry ?? DEFAULT_HTTP.telemetry,
    injectionGuard: http.injectionGuard ?? DEFAULT_HTTP.injectionGuard,
    cors: http.cors ?? DEFAULT_HTTP.cors,
  };
}

/** Register global Nest HTTP interceptors and guards for Ottrix. */
export function createHttpProviders(http?: OttrixHttpOptions): Provider[] {
  const resolved = resolveHttpOptions(http);
  const providers: Provider[] = [{ provide: OTTRIX_HTTP_OPTIONS, useValue: resolved }];

  if (resolved.runContext !== false) {
    if (typeof resolved.runContext === 'object') {
      providers.push({ provide: OTTRIX_RUN_CONTEXT_OPTIONS, useValue: resolved.runContext });
    }
    providers.push({ provide: APP_INTERCEPTOR, useClass: RunContextInterceptor });
  }

  if (resolved.telemetry) {
    providers.push({ provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor });
  }

  if (resolved.injectionGuard) {
    if (typeof resolved.injectionGuard === 'object') {
      providers.push({
        provide: OTTRIX_INJECTION_GUARD_OPTIONS,
        useValue: resolved.injectionGuard,
      });
    }
    providers.push({ provide: APP_GUARD, useClass: InjectionGuard });
  }

  return providers;
}
