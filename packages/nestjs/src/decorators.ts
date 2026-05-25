import { Inject } from '@nestjs/common';
import {
  agentToken,
  OTTRIX_PROVIDER_REGISTRY,
  OTTRIX_TELEMETRY,
  OTTRIX_TOOL_REGISTRY,
  providerToken,
} from './tokens.js';

/** Inject an {@link Agent} registered via {@link OttrixModule.forFeature}. */
export const InjectAgent = (name: string): ParameterDecorator => Inject(agentToken(name));

/** Inject a named provider or the full {@link ProviderRegistry} when omitted. */
export const InjectProvider = (name?: string): ParameterDecorator =>
  Inject(name ? providerToken(name) : OTTRIX_PROVIDER_REGISTRY);

/** Inject the global {@link ToolRegistry}. */
export const InjectToolRegistry = (): ParameterDecorator => Inject(OTTRIX_TOOL_REGISTRY);

/** Inject Ottrix {@link Telemetry}. */
export const InjectTelemetry = (): ParameterDecorator => Inject(OTTRIX_TELEMETRY);
