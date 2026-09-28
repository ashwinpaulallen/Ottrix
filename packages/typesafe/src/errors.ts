export class TypeSafeError extends Error {
  constructor(
    message: string,
    public readonly code: 'auth' | 'rate_limit' | 'timeout' | 'parse' | 'unknown',
    public readonly retryable: boolean,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'TypeSafeError';
  }
}

export function mapTypeSafeError(err: unknown): TypeSafeError {
  if (err instanceof TypeSafeError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('401') || message.includes('403') || message.includes('Unauthorized')) {
    return new TypeSafeError(
      'TypeSafe authentication failed. Check TYPESAFE_API_KEY.',
      'auth',
      false,
      err,
    );
  }
  if (message.includes('429') || message.includes('rate')) {
    return new TypeSafeError('TypeSafe rate limit exceeded.', 'rate_limit', true, err);
  }
  const errorName = err instanceof Error ? err.name : '';
  if (
    errorName === 'APITimeoutError' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('ETIMEDOUT')
  ) {
    return new TypeSafeError('TypeSafe request timed out.', 'timeout', true, err);
  }
  return new TypeSafeError(`TypeSafe error: ${message}`, 'unknown', false, err);
}
