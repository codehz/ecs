import { MISSING_COMPONENT, type Archetype } from "../archetype/archetype";
import type { ComponentEntityStore } from "../component/entity-store";
import { getDetailedIdType, type EntityId, type EntityIdManager } from "../entity";
import {
  decodeSerializedId,
  encodeEntityId,
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
  const entities: SerializedEntity[] = [];

  for (const archetype of archetypes) {
    const dumpedEntities = archetype.dump();
    for (const { entity, components } of dumpedEntities) {
      entities.push({
        id: encodeEntityId(entity),
        components: Array.from(components.entries()).map(([rawType, value]) => ({
          type: encodeEntityId(rawType),
          value: value === MISSING_COMPONENT ? undefined : value,
        })),
      });
    }
  }

  const componentEntitiesArr: SerializedEntity[] = [];
  for (const [entityId, components] of componentEntities.entries()) {
    componentEntitiesArr.push({
      id: encodeEntityId(entityId),
      components: Array.from(components.entries()).map(([rawType, value]) => ({
        type: encodeEntityId(rawType),
        value: value === MISSING_COMPONENT ? undefined : value,
      })),
    });
  }

  return {
    version: 1,
    entityManager: entityIdManager.serializeState(),
    entities,
    componentEntities: componentEntitiesArr,
  };
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
      const componentTypes: EntityId<any>[] = [];

      for (const componentEntry of componentsArray) {
        const componentType = decodeSerializedId(componentEntry.type);
        componentMap.set(componentType, componentEntry.value);
        componentTypes.push(componentType);
      }

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
