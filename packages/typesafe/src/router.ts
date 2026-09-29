import type { ToolRegistry, ToolRoutingDescriptor } from 'ottrix';
import { JevClient } from './client.js';
import type { ConfidenceThresholds, JevRoutingDecision, TypeSafeClientConfig } from './types.js';

export interface RouterConfig<TAgentName extends string> extends TypeSafeClientConfig {
  agents: Record<
    TAgentName,
    {
      description: string; // what this agent handles
      keywords?: string[]; // optional: helps Jev with fast classification
    }
  >;
  defaultAgent: TAgentName; // fallback when confidence is low
  thresholds?: Partial<ConfidenceThresholds>;
  /** When set, Jev receives the tool routing catalog instead of bare tool names. */
  toolRegistry?: ToolRegistry;
}

export class JevAgentRouter<TAgentName extends string> {
  private client: JevClient;
  private config: RouterConfig<TAgentName>;
  private thresholds: ConfidenceThresholds;

  constructor(config: RouterConfig<TAgentName>) {
    this.client = new JevClient(config);
    this.config = config;
    this.thresholds = {
      autoAct: config.thresholds?.autoAct ?? 0.8, // slightly lower for routing
      escalate: config.thresholds?.escalate ?? 0.5,
    };
  }

  async route(message: string): Promise<JevRoutingDecision<TAgentName>> {
    const start = Date.now();
    const agentNames = Object.keys(this.config.agents) as TAgentName[];

    const agentDescriptions = agentNames
      .map((name) => `${name}: ${this.config.agents[name].description}`)
      .join('\n');
    const availableTools = formatRoutingCatalog(this.config.toolRegistry?.getRoutingDescriptors());

    try {
      const { answers, latencyMs } = await this.client.decide({
        state: {
          userMessage: message,
          availableAgents: agentDescriptions,
          messageLength: message.length,
          ...(availableTools ? { availableTools } : {}),
        },
        questions: {
          agentName: JevClient.choice(
            'Which agent is best suited to handle this user message?',
            Object.fromEntries(agentNames.map((name) => [name, null])) as Record<TAgentName, null>,
          ),
        },
      });

      const agentName = (answers.agentName.choice ?? this.config.defaultAgent) as TAgentName;
      const confidence = answers.agentName.confidence;

      // Low confidence → default agent
      if (confidence < this.thresholds.escalate) {
        return {
          agentName: {
            value: this.config.defaultAgent,
            confidence,
            latencyMs,
          },
          confidence,
        };
      }

      return {
        agentName: {
          value: agentName,
          confidence,
          latencyMs,
        },
        confidence,
      };
    } catch (err) {
      console.warn('[ottrix:jev-router] Jev routing failed, using default agent:', err);
      return {
        agentName: {
          value: this.config.defaultAgent,
          confidence: 0,
          latencyMs: Date.now() - start,
        },
        confidence: 0,
      };
    }
  }

  /**
   * Route and return just the agent name.
   * Convenience method for simple use cases.
   */
  async routeSimple(message: string): Promise<TAgentName> {
    const decision = await this.route(message);
    return decision.agentName.value;
  }
}

function formatRoutingCatalog(descriptors: ToolRoutingDescriptor[] | undefined): string | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  return descriptors
    .map((tool) => {
      const summary = tool.routingDescription ?? tool.description;
      const parts = [`${tool.name}: ${summary}`];
      if (tool.keywords && tool.keywords.length > 0) {
        parts.push(`keywords: ${tool.keywords.join(', ')}`);
      }
      if (tool.examples && tool.examples.length > 0) {
        parts.push(`examples: ${tool.examples.join(' | ')}`);
      }
      if (tool.safetyClass) {
        parts.push(`safety: ${tool.safetyClass}`);
      }
      if (tool.priority !== 0) {
        parts.push(`priority: ${tool.priority}`);
      }
      return parts.join('; ');
    })
    .join('\n');
}
