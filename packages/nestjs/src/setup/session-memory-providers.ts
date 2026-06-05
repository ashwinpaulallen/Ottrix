import type { Provider } from '@nestjs/common';
import { OTTRIX_MODULE_OPTIONS, OTTRIX_SESSION_MEMORY } from '../tokens.js';
import type { OttrixModuleOptions } from '../interfaces.js';
import { SessionMemoryService } from '../session/session-memory.js';

/** Register {@link SessionMemoryService} when session memory is enabled in module options. */
export function createSessionMemoryProviders(options: OttrixModuleOptions): Provider[] {
  const sessionMemory = options.sessionMemory;
  if (!sessionMemory) {
    return [];
  }

  const serviceOptions = sessionMemory === true ? {} : sessionMemory;

  return [
    {
      provide: OTTRIX_SESSION_MEMORY,
      useFactory: () => new SessionMemoryService(serviceOptions),
    },
  ];
}

/** Session memory provider for {@link OttrixModule.forRootAsync}. */
export function createAsyncSessionMemoryProviders(): Provider[] {
  return [
    {
      provide: OTTRIX_SESSION_MEMORY,
      useFactory: (moduleOptions: OttrixModuleOptions) => {
        const sessionMemory = moduleOptions.sessionMemory;
        if (!sessionMemory) {
          return undefined;
        }
        const serviceOptions = sessionMemory === true ? {} : sessionMemory;
        return new SessionMemoryService(serviceOptions);
      },
      inject: [OTTRIX_MODULE_OPTIONS],
    },
  ];
}
