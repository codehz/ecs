import type { EntityId } from "../entity";
import { MultiMap } from "../utils/multi-map";

/**
 * Reverse reference index: maps each target entity to the set of (source entity, component) pairs
 * that currently hold a reference to it.
 *
 * Used internally to support efficient entity deletion, including:
 * - Fast-path deletion for unreferenced entities
 * - Cascading deletes for relations marked with `cascadeDelete`
 * - Automatic cleanup of entity-valued components and entity-relations when their target is destroyed
 *
 * Structure:
 *   targetEntityId -> MultiMap<sourceEntityId, componentOrRelationId>
 *
 * - For plain entity-valued components (component value is an EntityId):
 *     componentOrRelationId === the component type (which is also the entity id being pointed to)
 * - For entity-relations (`relation(Comp, target)`):
 *     componentOrRelationId is the encoded (negative) relation ID
 *
 * This index is maintained in sync with structural changes via `updateEntityReferences` in World.
 *
 * @internal
 */
export type EntityReferencesMap = Map<EntityId, MultiMap<EntityId, EntityId>>;

/**
 * Record that `sourceEntityId` holds a reference to `targetEntityId` via the given component/relation.
 *
 * Called when an entity-valued component or an entity-relation is added to an entity.
 *
 * @param entityReferences - The shared reverse index map
 * @param sourceEntityId - The entity that contains the reference
 * @param componentType - The component type or encoded relation ID used for the reference
 * @param targetEntityId - The entity being referenced
 *
 * @internal
 */
export function trackEntityReference(
  entityReferences: EntityReferencesMap,
  sourceEntityId: EntityId,
  componentType: EntityId,
  targetEntityId: EntityId,
): void {
  if (!entityReferences.has(targetEntityId)) {
    entityReferences.set(targetEntityId, new MultiMap());
  }
  entityReferences.get(targetEntityId)!.add(sourceEntityId, componentType);
}

/**
 * Remove the record that `sourceEntityId` references `targetEntityId` via the given component/relation.
 *
 * Called when an entity-valued component or entity-relation is removed (or during deletion).
 * Automatically prunes empty target entries from the map.
 *
 * @param entityReferences - The shared reverse index map
 * @param sourceEntityId - The entity that no longer holds the reference
 * @param componentType - The component type or encoded relation ID that was used
 * @param targetEntityId - The previously referenced entity
 *
 * @internal
 */
export function untrackEntityReference(
  entityReferences: EntityReferencesMap,
  sourceEntityId: EntityId,
  componentType: EntityId,
  targetEntityId: EntityId,
): void {
  const references = entityReferences.get(targetEntityId);
  if (references) {
    references.remove(sourceEntityId, componentType);
    if (references.keyCount === 0) {
      entityReferences.delete(targetEntityId);
    }
  }
}

/**
 * Iterate over all (sourceEntityId, componentOrRelationId) pairs that currently reference the given target.
 *
 * Returns an empty iterable when the target has no incoming references.
 * The returned iterable yields `[source, componentType]` pairs suitable for cleanup decisions
 * (e.g. whether to cascade-delete the source or just remove the specific component/relation).
 *
 * @param entityReferences - The shared reverse index map
 * @param targetEntityId - The entity whose referrers we want to inspect
 * @returns Iterable of [sourceEntityId, componentOrRelationId]
 *
 * @internal
 */
export function getEntityReferences(
  entityReferences: EntityReferencesMap,
  targetEntityId: EntityId,
): Iterable<[EntityId, EntityId]> {
  return entityReferences.get(targetEntityId) ?? new MultiMap();
}
