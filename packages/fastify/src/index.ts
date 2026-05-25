export {
  ottrixPlugin,
  type OttrixPluginOptions,
  type OttrixProviderOptions,
  type OttrixInjectionOptions,
  type OttrixRunContextOptions,
} from './plugin.js';
export { agentRoutes, type AgentRoutesOptions } from './routes.js';
export { mapOttrixError, registerOttrixErrorHandler, BudgetExhaustedError } from './errors.js';
export type { OttrixFastifyState } from './types.js';
import './types.js';
