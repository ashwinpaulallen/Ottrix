/** Injection token for {@link OttrixModuleOptions}. */
export const OTTRIX_MODULE_OPTIONS = Symbol('OTTRIX_MODULE_OPTIONS');

/** Injection token for the global {@link ToolRegistry}. */
export const OTTRIX_TOOL_REGISTRY = Symbol('OTTRIX_TOOL_REGISTRY');

/** Injection token for the {@link Telemetry} service wrapper. */
export const OTTRIX_TELEMETRY = Symbol('OTTRIX_TELEMETRY');

/** Injection token for {@link ProviderRegistryService}. */
export const OTTRIX_PROVIDER_REGISTRY = Symbol('OTTRIX_PROVIDER_REGISTRY');

/** Injection token for {@link GuardrailService}. */
export const OTTRIX_GUARDRAIL_SERVICE = Symbol('OTTRIX_GUARDRAIL_SERVICE');

/** Injection token for {@link RunContextService}. */
export const OTTRIX_RUN_CONTEXT = Symbol('OTTRIX_RUN_CONTEXT');

/** Injection token for {@link MCPRegistry}. */
export const OTTRIX_MCP_REGISTRY = Symbol('OTTRIX_MCP_REGISTRY');

/** Build an injection token for a named agent. */
export function agentToken(name: string): string {
  return `OTTRIX_AGENT_${name}`;
}

/** Build an injection token for a named workflow. */
export function workflowToken(name: string): string {
  return `OTTRIX_WORKFLOW_${name}`;
}

/** Build an injection token for a named provider. */
export function providerToken(name: string): string {
  return `OTTRIX_PROVIDER_${name}`;
}

/** Unique per {@link OttrixModule.forFeature} call — serializes tool registration for that feature. */
export function featureToolsToken(): symbol {
  return Symbol('OTTRIX_FEATURE_TOOLS');
}
