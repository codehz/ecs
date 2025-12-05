import type { Archetype } from "./archetype";
import type { EntityId } from "./entity";
import { getComponentIdFromRelationId, getDetailedIdType, isRelationId } from "./entity";

/**
 * Filter options for queries
 */
export interface QueryFilter {
  negativeComponentTypes?: EntityId<any>[];
}

/**
 * Serialize a QueryFilter into a deterministic string suitable for cache keys.
 * Currently only serializes `negativeComponentTypes`.
 */
export function serializeQueryFilter(filter: QueryFilter = {}): string {
  const negative = (filter.negativeComponentTypes || []).slice().sort((a, b) => a - b);
  if (negative.length === 0) return "";
  return `neg:${negative.join(",")}`;
}

/**
 * Check if an archetype matches the given component types
 */
export function matchesComponentTypes(archetype: Archetype, componentTypes: EntityId<any>[]): boolean {
  return componentTypes.every((type) => {
    const detailedType = getDetailedIdType(type);
    if (detailedType.type === "wildcard-relation") {
      // For wildcard relations, check if archetype contains the component relation
      return archetype.componentTypes.some((archetypeType) => {
        if (!isRelationId(archetypeType)) return false;
        const componentId = getComponentIdFromRelationId(archetypeType);
        return componentId === detailedType.componentId;
      });
    } else {
      // For regular components, check direct inclusion
      return archetype.componentTypes.includes(type);
    }
  });
}

/**
 * Check if an archetype matches the filter conditions (only filtering logic)
 */
export function matchesFilter(archetype: Archetype, filter: QueryFilter): boolean {
  const negativeTypes = filter.negativeComponentTypes || [];
  return negativeTypes.every((type) => {
    const detailedType = getDetailedIdType(type);
    if (detailedType.type === "wildcard-relation") {
      // For wildcard relations in negative filter, exclude archetypes that contain ANY relation with the same component
      return !archetype.componentTypes.some((archetypeType) => {
        if (!isRelationId(archetypeType)) return false;
        const componentId = getComponentIdFromRelationId(archetypeType);
        return componentId === detailedType.componentId;
      });
    } else {
      // For regular components, check direct exclusion
      return !archetype.componentTypes.includes(type);
    }
  });
}
