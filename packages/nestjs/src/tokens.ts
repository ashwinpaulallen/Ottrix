/** Injection token for {@link OttrixModuleOptions}. */
export const OTTRIX_MODULE_OPTIONS = Symbol('OTTRIX_MODULE_OPTIONS');

/** Injection token for the global {@link ToolRegistry}. */
export const OTTRIX_TOOL_REGISTRY = Symbol('OTTRIX_TOOL_REGISTRY');

/** Injection token for Ottrix {@link Telemetry}. */
export const OTTRIX_TELEMETRY = Symbol('OTTRIX_TELEMETRY');

/** Injection token for the global {@link ProviderRegistry}. */
export const OTTRIX_PROVIDER_REGISTRY = Symbol('OTTRIX_PROVIDER_REGISTRY');

/** Injection token for registered provider names (startup summary / health). */
export const OTTRIX_PROVIDER_NAMES = Symbol('OTTRIX_PROVIDER_NAMES');

/** Injection token for {@link RunContextInterceptor} options. */
export const OTTRIX_RUN_CONTEXT_OPTIONS = Symbol('OTTRIX_RUN_CONTEXT_OPTIONS');

/** Injection token for resolved Ottrix HTTP feature flags. */
export const OTTRIX_HTTP_OPTIONS = Symbol('OTTRIX_HTTP_OPTIONS');

/** Injection token for {@link InjectionGuard} options. */
export const OTTRIX_INJECTION_GUARD_OPTIONS = Symbol('OTTRIX_INJECTION_GUARD_OPTIONS');

/** Build an injection token for a named agent. */
export function agentToken(name: string): string {
  return `OTTRIX_AGENT_${name}`;
}

/** Build an injection token for a named provider. */
export function providerToken(name: string): string {
  return `OTTRIX_PROVIDER_${name}`;
}

/** Unique per {@link OttrixModule.forFeature} call — serializes tool registration for that feature. */
export function featureToolsToken(): symbol {
  return Symbol('OTTRIX_FEATURE_TOOLS');
}
