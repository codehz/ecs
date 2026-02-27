import type { EntityId } from "./entity";

/**
 * Normalize component type collections into a stable ascending order.
 * This keeps cache keys and archetype signatures deterministic.
 */
export function normalizeComponentTypes(componentTypes: Iterable<EntityId<any>>): EntityId<any>[] {
  return [...componentTypes].sort((a, b) => a - b);
}
