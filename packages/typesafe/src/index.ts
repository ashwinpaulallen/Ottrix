// Client
export { JevClient, createJevClient } from './client.js';

// Strategies (plug into ottrix's EvaluatorStrategy interface)
export { JevEvaluatorStrategy } from './evaluator.js';

// Guardrails
export { JevInjectionGuardrail } from './guardrail.js';

// Routing
export { JevAgentRouter } from './router.js';

// Decisions
export { JevDecisionMaker } from './decisions.js';

// Types
export {
  DEFAULT_THRESHOLDS,
  type ConfidenceThresholds,
  type InjectionCategory,
  type JevBooleanDecision,
  type JevChoiceDecision,
  type JevDecision,
  type JevDecisionMakerConfig,
  type JevEvaluatorConfig,
  type JevGuardrailConfig,
  type JevInjectionDecision,
  type JevRoutingDecision,
  type JevScoreDecision,
  type JevSufficiencyDecision,
  type JevToolAcceptanceDecision,
  type RouterConfig,
  type TypeSafeClientConfig,
} from './types.js';

// Errors
export { TypeSafeError, mapTypeSafeError } from './errors.js';
