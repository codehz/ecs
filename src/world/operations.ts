import type { ComponentId, EntityId } from "../entity";
import { getDetailedIdType } from "../entity";

/**
 * Validation and overload-resolution helpers extracted from World.
 *
 * These were previously private methods on World. Moving them reduces line count
 * in the core class with almost zero coupling (the only dep is a liveness predicate
 * for assertEntityExists, supplied by the caller).
 *
 * Pure type checks (assert*TypeValid) and the resolve* helpers for set/remove
 * singleton-vs-entity overloads live here.
 */

/**
 * Assert that an entity (or component-entity) is alive in the world.
 * The caller supplies the liveness check (World.exists or equivalent) to keep
 * this module free of direct references to stores.
 */
export function assertEntityExists(
  entityId: EntityId,
  label: "Entity" | "Component entity",
  exists: (id: EntityId) => boolean,
): void {
  if (!exists(entityId)) {
    throw new Error(`${label} ${entityId} does not exist`);
  }
}

export function assertComponentTypeValid(componentType: EntityId): void {
  const detailedType = getDetailedIdType(componentType);
  if (detailedType.type === "invalid") {
    throw new Error(`Invalid component type: ${componentType}`);
  }
}

export function assertSetComponentTypeValid(componentType: EntityId): void {
  const detailedType = getDetailedIdType(componentType);
  if (detailedType.type === "invalid") {
    throw new Error(`Invalid component type: ${componentType}`);
  }
  if (detailedType.type === "wildcard-relation") {
    throw new Error(`Cannot directly add wildcard relation components: ${componentType}`);
  }
}

/**
 * Resolve the (entity, componentType, value) for a set() call, handling the
 * singleton component overload (set(componentId, data)) vs normal entity form.
 */
export function resolveSetOperation(
  entityId: EntityId | ComponentId,
  componentTypeOrComponent?: EntityId | any,
  maybeComponent?: any,
  exists: (id: EntityId) => boolean = () => true, // default permissive for tests / internal
): { entityId: EntityId; componentType: EntityId; component: any } {
  // Handle singleton component overload: set(componentId, data)
  if (maybeComponent === undefined && componentTypeOrComponent !== undefined) {
    const detailedType = getDetailedIdType(entityId);
    if (detailedType.type === "component" || detailedType.type === "component-relation") {
      const componentId = entityId as ComponentId;
      assertEntityExists(componentId, "Component entity", exists);
      assertSetComponentTypeValid(componentId);
      return { entityId: componentId, componentType: componentId, component: componentTypeOrComponent };
    }
  }

  const targetEntityId = entityId as EntityId;
  const componentType = componentTypeOrComponent as EntityId;
  assertEntityExists(targetEntityId, "Entity", exists);
  assertSetComponentTypeValid(componentType);

  return { entityId: targetEntityId, componentType, component: maybeComponent };
}

/**
 * Resolve the (entity, componentType) for a remove() call, handling the
 * singleton component overload (remove(componentId)).
 */
export function resolveRemoveOperation<T>(
  entityId: EntityId | ComponentId,
  componentType?: EntityId<T>,
  exists: (id: EntityId) => boolean = () => true,
): { entityId: EntityId; componentType: EntityId } {
  // Handle singleton component overload: remove(componentId)
  if (componentType === undefined) {
    const componentId = entityId as ComponentId<T>;
    assertEntityExists(componentId, "Component entity", exists);
    return { entityId: componentId, componentType: componentId };
  }

  const targetEntityId = entityId as EntityId;
  assertEntityExists(targetEntityId, "Entity", exists);
  assertComponentTypeValid(componentType);

  return { entityId: targetEntityId, componentType };
}

// Re-export the type for callers that need it in signatures (ComponentId lives in entity)
export type { ComponentId } from "../entity";
