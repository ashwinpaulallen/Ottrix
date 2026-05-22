import { Inject, Injectable } from '@nestjs/common';
import {
  BudgetGuardrail,
  createGuardrails,
  GuardrailMiddleware,
  PromptInjectionGuardrail,
} from 'ottrix/guardrails';
import type { OttrixGuardrailsConfig, OttrixModuleOptions } from '../interfaces.js';
import { OTTRIX_MODULE_OPTIONS } from '../tokens.js';

/** Configures and exposes Ottrix guardrails for NestJS guards and agents. */
@Injectable()
export class GuardrailService {
  private readonly guardrailsConfig: OttrixGuardrailsConfig;
  private readonly injectionMode: 'block' | 'flag' | 'sanitize';
  private readonly injectionGuardrail: PromptInjectionGuardrail;
  private readonly budgetGuardrail: BudgetGuardrail;
  private readonly middleware: GuardrailMiddleware;

  constructor(@Inject(OTTRIX_MODULE_OPTIONS) options: OttrixModuleOptions) {
    this.guardrailsConfig = options.guardrails ?? {};
    this.injectionMode = this.guardrailsConfig.injection?.mode ?? 'block';
    const stack = createGuardrails(this.toCreateGuardrailsConfig(this.guardrailsConfig));

    this.middleware = stack.middleware;
    this.budgetGuardrail =
      stack.budget ??
      new BudgetGuardrail({
        maxTokenBudget: this.guardrailsConfig.budget?.maxTokens,
        maxCostUsd: this.guardrailsConfig.budget?.maxCostUsd,
        maxSteps: this.guardrailsConfig.budget?.maxSteps,
      });

    this.injectionGuardrail = new PromptInjectionGuardrail({
      mode: this.guardrailsConfig.injection?.mode ?? 'block',
      strictness: this.guardrailsConfig.injection?.strictness ?? 'medium',
    });
  }

  /** Shared guardrail middleware for agent construction. */
  getMiddleware(): GuardrailMiddleware {
    return this.middleware;
  }

  /** Prompt injection guardrail used by {@link InjectionGuard}. */
  getInjectionGuardrail(): PromptInjectionGuardrail {
    return this.injectionGuardrail;
  }

  /** Budget guardrail used by {@link BudgetGuard}. */
  getBudgetGuardrail(): BudgetGuardrail {
    return this.budgetGuardrail;
  }

  /** Injection guardrail mode configured on the module. */
  getInjectionMode(): 'block' | 'flag' | 'sanitize' {
    return this.injectionMode;
  }

  /** Create agent-scoped guardrail middleware. */
  createForAgent(agentName: string): GuardrailMiddleware {
    return createGuardrails(this.toCreateGuardrailsConfig(this.guardrailsConfig, agentName))
      .middleware;
  }

  private toCreateGuardrailsConfig(
    guardrails: OttrixGuardrailsConfig,
    agentName = 'agent',
  ): Parameters<typeof createGuardrails>[0] {
    const piiMode = guardrails.pii?.mode;

    return {
      agentName,
      budget: {
        maxTokenBudget: guardrails.budget?.maxTokens,
        maxCostUsd: guardrails.budget?.maxCostUsd,
        maxSteps: guardrails.budget?.maxSteps,
      },
      pii: piiMode
        ? {
            mode: piiMode === 'block' || piiMode === 'tokenize' ? 'redact' : 'detect',
            blockOnDetect: piiMode === 'block',
          }
        : undefined,
      promptInjection: guardrails.injection
        ? {
            mode: guardrails.injection.mode ?? 'block',
            strictness: guardrails.injection.strictness ?? 'medium',
          }
        : undefined,
    };
  }
}
