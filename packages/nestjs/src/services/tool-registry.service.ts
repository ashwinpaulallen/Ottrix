import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ToolRegistry } from 'ottrix/tools';
import { MCPRegistry } from 'ottrix/tools';

/** Global tool registry for NestJS applications. */
@Injectable()
export class ToolRegistryService implements OnModuleDestroy {
  private readonly registry = new ToolRegistry();
  private readonly mcpRegistry = new MCPRegistry();

  /** Underlying Ottrix tool registry. */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /** MCP server registry for health checks and lifecycle. */
  getMcpRegistry(): MCPRegistry {
    return this.mcpRegistry;
  }

  async onModuleDestroy(): Promise<void> {
    await this.mcpRegistry.disconnectAll();
  }
}
