/**
 * Utility functions for ECS library
 */

/**
 * Get a value from cache or compute and cache it if not present
 * @param cache The cache map
 * @param key The cache key
 * @param compute Function to compute the value if not cached (may have side effects)
 * @returns The cached or computed value
 */
export function getOrCompute<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  let value = cache.get(key);
  if (value === undefined) {
    value = compute();
    cache.set(key, value);
  }
  return value;
}

/**
 * Alias for getOrCompute - maintained for backwards compatibility
 * @deprecated Use getOrCompute instead
 */
export const getOrComputeCache = getOrCompute;

/**
 * Alias for getOrCompute - maintained for backwards compatibility
 * @deprecated Use getOrCompute instead
 */
export const getOrCreateWithSideEffect = getOrCompute;
