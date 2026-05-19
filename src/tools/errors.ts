/**
 * Thrown when tool/registry configuration is invalid or incomplete.
 */
export class ConfigurationError extends Error {
  readonly name = 'ConfigurationError';

  constructor(message: string) {
    super(message);
  }

  /** Type guard for {@link ConfigurationError}. */
  static isConfigurationError(error: unknown): error is ConfigurationError {
    return error instanceof ConfigurationError;
  }
}
