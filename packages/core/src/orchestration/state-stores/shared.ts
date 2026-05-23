/** Optional peer dependency loader for state store adapters. */
export async function importOptionalPeer<T>(packageName: string): Promise<T> {
  try {
    return (await import(/* webpackIgnore: true */ packageName)) as T;
  } catch {
    const { StateStorePeerDependencyError } = await import('../state-store.js');
    throw new StateStorePeerDependencyError(packageName);
  }
}

/** Hash a workflow ID into two 32-bit advisory lock keys for PostgreSQL. */
export function advisoryLockKeys(workflowId: string): [number, number] {
  let hash1 = 0;
  let hash2 = 0;
  for (let i = 0; i < workflowId.length; i += 1) {
    const code = workflowId.charCodeAt(i);
    hash1 = (hash1 * 31 + code) | 0;
    hash2 = (hash2 * 37 + code) | 0;
  }
  return [hash1, hash2];
}

/** Match tag filters against a JSON tags object. */
export function tagsMatch(
  stored: Record<string, string> | null | undefined,
  filter?: Record<string, string>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }
  if (!stored) {
    return false;
  }
  return Object.entries(filter).every(([key, value]) => stored[key] === value);
}
