import { describe, expect, it } from 'vitest';
import { Logger, setGlobalLogLevel } from '../../src/observability/logger.js';

describe('Logger', () => {
  it('filters by level and supports child context', () => {
    setGlobalLogLevel('warn');
    const entries: string[] = [];

    const logger = new Logger({
      component: 'parent',
      handler: (entry) => entries.push(`${entry.level}:${entry.message}`),
    });

    logger.info('hidden');
    logger.warn('visible');

    const child = logger.child({ agentName: 'researcher' });
    child.error('child error');

    expect(entries).toEqual(['warn:visible', 'error:child error']);
  });

  it('supports silent mode for tests', () => {
    const logger = new Logger({
      silent: true,
      handler: () => {
        throw new Error('should not log');
      },
    });

    expect(() => logger.error('quiet')).not.toThrow();
  });
});
