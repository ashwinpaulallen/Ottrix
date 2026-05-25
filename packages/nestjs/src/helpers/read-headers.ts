/** Normalize Nest/Express request headers for {@link buildRunContext}. */
export function readHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value[0];
    } else if (value !== undefined) {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}
