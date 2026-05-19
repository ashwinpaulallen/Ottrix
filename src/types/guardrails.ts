import type { AgentStep } from './agent.js';

/**
 * Severity of a failed or advisory validation.
 */
export type ValidationSeverity = 'info' | 'warning' | 'error';

/**
 * Outcome of validating content against a policy.
 */
export interface ValidationResult {
  /** Whether the content passed validation. */
  passed: boolean;
  /** Explanation when validation fails or warns. */
  reason?: string;
  /** How critical the finding is. */
  severity?: ValidationSeverity;
}

/**
 * Pluggable content validator (PII, toxicity, policy checks, etc.).
 */
export interface Validator {
  /** Unique validator name for logging. */
  name: string;
  /**
   * Validate arbitrary text content.
   *
   * @param content - User input or model output to inspect.
   */
  validate(content: string): Promise<ValidationResult>;
}

/**
 * Budget, validation, and human-in-the-loop policies for an agent run.
 */
export interface GuardrailConfig {
  /** Maximum tokens allowed for the entire run. */
  maxTokenBudget?: number;
  /** Maximum agent loop steps. */
  maxSteps?: number;
  /** Maximum estimated USD cost before halting. */
  maxCostUsd?: number;
  /** Validators applied to inbound user content. */
  inputValidators?: Validator[];
  /** Validators applied to model output before delivery. */
  outputValidators?: Validator[];
  /**
   * Return `true` to pause and require human approval before continuing.
   *
   * @param step - The step that triggered the approval check.
   */
  requireApproval?: (step: AgentStep) => boolean;
}
