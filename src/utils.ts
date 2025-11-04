/**
 * Utility functions for ECS library
 */

/**
 * Get a value from cache or compute and cache it if not present
 * @param cache The cache map
 * @param key The cache key
 * @param compute Function to compute the value if not cached
 * @returns The cached or computed value
 */
export function getOrComputeCache<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  let value = cache.get(key);
  if (value === undefined) {
    value = compute();
    cache.set(key, value);
  }
  return value;
}

/**
 * Get a value from cache or create and cache it if not present, allowing side effects during creation
 * @param cache The cache map
 * @param key The cache key
 * @param create Function to create the value if not cached (can have side effects)
 * @returns The cached or created value
 */
export function getOrCreateWithSideEffect<K, V>(cache: Map<K, V>, key: K, create: () => V): V {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    cache.set(key, value);
  }
  return value;
}
