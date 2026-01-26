import { MultiMap } from "../utils/multi-map";
import type { EntityId } from "./entity";

export type EntityReferencesMap = Map<EntityId, MultiMap<EntityId, EntityId>>;

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

export function getEntityReferences(
  entityReferences: EntityReferencesMap,
  targetEntityId: EntityId,
): Iterable<[EntityId, EntityId]> {
  return entityReferences.get(targetEntityId) ?? new MultiMap();
}
