import type { JSONSchema } from '../types/tools.js';
import type { GuardrailConfig, Validator } from '../types/guardrails.js';
import { AuditLogger, type AuditLoggerOptions } from './audit.js';
import { BudgetGuardrail, type BudgetGuardrailOptions, type TokenCostRates } from './budget.js';
import { GuardrailMiddleware } from './middleware.js';
import { HumanApprovalGuardrail, type HumanApprovalGuardrailOptions } from './human-in-the-loop.js';
import {
  ContentFilter,
  MaxLengthValidator,
  PiiDetector,
  SchemaValidator,
  type PiiMode,
} from './validators.js';
import type { GuardrailHandler } from './types.js';
import {
  DEFAULT_PROMPT_INJECTION_OPTIONS,
  PromptInjectionGuardrail,
  type PromptInjectionGuardrailOptions,
} from './injection.js';

/** Configuration for {@link createGuardrails}. */
export interface CreateGuardrailsConfig {
  /** Agent name used in audit logs and middleware context. */
  agentName?: string;
  /** Provider name for cost estimation. */
  providerName?: string;
  budget?: BudgetGuardrailOptions;
  pii?: {
    mode?: PiiMode;
    blockOnDetect?: boolean;
  };
  contentFilter?: {
    patterns: Array<string | RegExp>;
    action?: 'block' | 'flag';
  };
  outputSchema?: JSONSchema;
  maxOutputLength?: {
    maxCharacters?: number;
    maxTokens?: number;
  };
  humanApproval?: HumanApprovalGuardrailOptions;
  audit?: AuditLoggerOptions;
  promptInjection?: false | Omit<PromptInjectionGuardrailOptions, 'auditLogger' | 'agentName'>;
}

/** Result of {@link createGuardrails}. */
export interface CreateGuardrailsResult {
  middleware: GuardrailMiddleware;
  budget?: BudgetGuardrail;
  audit?: AuditLogger;
  /** Legacy {@link GuardrailConfig} for `Agent` constructor compatibility. */
  config: GuardrailConfig;
}

/**
 * Build a composed guardrail stack from a single configuration object.
 */
export function createGuardrails(options: CreateGuardrailsConfig = {}): CreateGuardrailsResult {
  const handlers: GuardrailHandler[] = [];
  const agentName = options.agentName ?? 'agent';

  let audit: AuditLogger | undefined;
  if (options.audit) {
    audit = new AuditLogger({ agentName, ...options.audit });
    handlers.push(audit);
  }

  let budget: BudgetGuardrail | undefined;
  if (options.budget) {
    budget = new BudgetGuardrail({
      providerName: options.providerName,
      ...options.budget,
    });
    handlers.push(budget);
  }

  let piiDetector: PiiDetector | undefined;
  if (options.pii) {
    piiDetector = new PiiDetector({
      mode: options.pii.mode,
      blockOnDetect: options.pii.blockOnDetect,
    });
    handlers.push(piiDetector);
  }

  let contentFilter: ContentFilter | undefined;
  if (options.contentFilter) {
    contentFilter = new ContentFilter({
      patterns: options.contentFilter.patterns,
      action: options.contentFilter.action,
    });
    handlers.push(contentFilter);
  }

  let schemaValidator: SchemaValidator | undefined;
  if (options.outputSchema) {
    schemaValidator = new SchemaValidator(options.outputSchema);
    handlers.push(schemaValidator);
  }

  let maxLengthValidator: MaxLengthValidator | undefined;
  if (options.maxOutputLength) {
    maxLengthValidator = new MaxLengthValidator(options.maxOutputLength);
    handlers.push(maxLengthValidator);
  }

  if (options.humanApproval) {
    handlers.push(new HumanApprovalGuardrail(options.humanApproval));
  }

  if (options.promptInjection !== false) {
    handlers.push(
      new PromptInjectionGuardrail({
        ...DEFAULT_PROMPT_INJECTION_OPTIONS,
        ...(options.promptInjection ?? {}),
        agentName,
        auditLogger: audit,
      }),
    );
  }

  const middleware = new GuardrailMiddleware(handlers);

  const outputValidators: Validator[] = [];
  if (contentFilter) {
    outputValidators.push(contentFilter);
  }
  if (schemaValidator) {
    outputValidators.push(schemaValidator);
  }
  if (maxLengthValidator) {
    outputValidators.push(maxLengthValidator);
  }

  const config: GuardrailConfig = {
    maxSteps: options.budget?.maxSteps,
    maxTokenBudget: options.budget?.maxTokenBudget,
    maxCostUsd: options.budget?.maxCostUsd,
    inputValidators: piiDetector ? [piiDetector] : undefined,
    outputValidators: outputValidators.length > 0 ? outputValidators : undefined,
  };

  return { middleware, budget, audit, config };
}

export type { TokenCostRates };
