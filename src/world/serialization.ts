import { MISSING_COMPONENT, type Archetype } from "../archetype/archetype";
import type { ComponentEntityStore } from "../component/entity-store";
import { getDetailedIdType, type EntityId, type EntityIdManager } from "../entity";
import {
  decodeSerializedId,
  encodeEntityIdCached,
  type SerializedComponent,
  type SerializedEntity,
  type SerializedWorld,
} from "../storage/serialization";
import { trackEntityReference, type EntityReferencesMap } from "./references";

/**
 * Serializes the full world state to a plain JS object suitable for JSON encoding.
 */
export function serializeWorld(
  archetypes: Archetype[],
  componentEntities: ComponentEntityStore,
  entityIdManager: EntityIdManager,
): SerializedWorld {
  // ID cache turns repeated encode work (especially component type IDs) into O(#unique IDs)
  const idCache = new Map<any, any>();

  const entities: SerializedEntity[] = [];

  for (const archetype of archetypes) {
    // Pre-encode this archetype's component type IDs exactly once (big win when many entities share the archetype)
    const encodedComponentTypes = archetype.componentTypes.map((t) => encodeEntityIdCached(t, idCache));

    // The append method will use the bulk helper internally when a pre-fetched map is supplied.
    // For now we rely on the per-entity fallback inside the archetype (already much cheaper than old dump path).
    archetype.appendSerializedEntities(entities, (id) => encodeEntityIdCached(id, idCache), encodedComponentTypes);
  }

  const componentEntitiesArr: SerializedEntity[] = [];
  for (const [entityId, components] of componentEntities.entries()) {
    componentEntitiesArr.push({
      id: encodeEntityIdCached(entityId, idCache),
      components: serializeComponentsFromMap(components, idCache),
    });
  }

  return {
    version: 1,
    entityManager: entityIdManager.serializeState(),
    entities,
    componentEntities: componentEntitiesArr,
  };
}

/** Small helper to avoid duplicating the "Map → SerializedComponent[] with cache" pattern. */
function serializeComponentsFromMap(
  components: Map<EntityId<any>, any>,
  idCache: Map<any, any>,
): SerializedComponent[] {
  const result: SerializedComponent[] = [];
  for (const [rawType, value] of components) {
    result.push({
      type: encodeEntityIdCached(rawType, idCache),
      value: value === MISSING_COMPONENT ? undefined : value,
    });
  }
  return result;
}

/**
 * Context needed by `deserializeWorld` to populate world-internal state.
 * Defined as an interface to avoid a circular import between world.ts and this module.
 */
export interface WorldDeserializationContext {
  entityIdManager: EntityIdManager;
  componentEntities: ComponentEntityStore;
  entityReferences: EntityReferencesMap;
  ensureArchetype(componentTypes: EntityId<any>[]): Archetype;
  setEntityToArchetype(entityId: EntityId, archetype: Archetype): void;
}

/**
 * Restores world state from a snapshot into the provided context.
 * Intended to be called from `World`'s constructor.
 */
export function deserializeWorld(ctx: WorldDeserializationContext, snapshot: SerializedWorld): void {
  if (snapshot.entityManager) {
    ctx.entityIdManager.deserializeState(snapshot.entityManager);
  }

  if (Array.isArray(snapshot.componentEntities)) {
    for (const entry of snapshot.componentEntities) {
      const entityId = decodeSerializedId(entry.id);
      if (!ctx.componentEntities.exists(entityId)) continue;

      const componentsArray: SerializedComponent[] = entry.components || [];
      const componentMap = new Map<EntityId<any>, any>();

      for (const componentEntry of componentsArray) {
        const componentType = decodeSerializedId(componentEntry.type);
        componentMap.set(componentType, componentEntry.value);
      }

      ctx.componentEntities.initFromSnapshot(entityId, componentMap);
    }
  }

  if (Array.isArray(snapshot.entities)) {
    for (const entry of snapshot.entities) {
      const entityId = decodeSerializedId(entry.id);
      const componentsArray: SerializedComponent[] = entry.components || [];

      const componentMap = new Map<EntityId<any>, any>();

      for (const componentEntry of componentsArray) {
        const componentType = decodeSerializedId(componentEntry.type);
        componentMap.set(componentType, componentEntry.value);
      }

      // Build the list of component types from the map we just populated (no redundant push loop)
      const componentTypes = Array.from(componentMap.keys());

      // ensureArchetype is internally memoized (getOrCompute on signature), so repeated calls
      // for the same component set are cheap after the first archetype is created.
      const archetype = ctx.ensureArchetype(componentTypes);
      archetype.addEntity(entityId, componentMap);
      ctx.setEntityToArchetype(entityId, archetype);

      for (const compType of componentTypes) {
        const detailedType = getDetailedIdType(compType);
        if (detailedType.type === "entity-relation") {
          // Safe: targetId guaranteed for entity-relation type
          trackEntityReference(ctx.entityReferences, entityId, compType, detailedType.targetId);
        } else if (detailedType.type === "entity") {
          trackEntityReference(ctx.entityReferences, entityId, compType, compType);
        }
      }
    }
  }
}
