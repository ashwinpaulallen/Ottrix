import { Inject } from '@nestjs/common';
import {
  agentToken,
  OTTRIX_TELEMETRY,
  OTTRIX_TOOL_REGISTRY,
  providerToken,
  workflowToken,
} from './tokens.js';

/** Inject an {@link Agent} registered via {@link OttrixModule.forFeature}. */
export const InjectAgent = (name: string): ParameterDecorator => Inject(agentToken(name));

/** Inject a {@link DAGWorkflow} registered via {@link OttrixModule.forFeature}. */
export const InjectWorkflow = (name: string): ParameterDecorator =>
  Inject(workflowToken(name));

/** Inject a {@link CompletionProvider} by registry name. */
export const InjectProvider = (name: string): ParameterDecorator =>
  Inject(providerToken(name));

/** Inject the global {@link ToolRegistry}. */
export const InjectToolRegistry = (): ParameterDecorator => Inject(OTTRIX_TOOL_REGISTRY);

/** Inject the Ottrix {@link Telemetry} wrapper. */
export const InjectTelemetry = (): ParameterDecorator => Inject(OTTRIX_TELEMETRY);
