import { MISSING_COMPONENT, type Archetype } from "../archetype/archetype";
import type { ComponentEntityStore } from "../component/entity-store";
import { shouldSkipSerialize } from "../component/registry";
import { getDetailedIdType, type EntityId, type EntityIdManager } from "../entity";
import {
  decodeSerializedId,
  encodeEntityIdCached,
  type SerializedComponent,
  type SerializedEntity,
  type SerializedEntityId,
  type SerializedWorld,
} from "../storage/serialization";
import { trackEntityReference, type EntityReferencesMap } from "./references";

/** Options for {@link serializeWorld}. */
export interface SerializeWorldOptions {
  /**
   * When `true`, include components marked {@link ComponentOptions.skipSerialize}
   * (and relations whose base has that flag). Intended for debug dumps only
   * ({@link World.dump}); restore paths still drop these types via
   * {@link deserializeWorld}. Default `false` (save-game / network snapshot).
   */
  includeSkipSerialize?: boolean;
}

/**
 * Serializes the full world state to a plain JS object suitable for JSON encoding.
 *
 * By default, components registered with {@link ComponentOptions.skipSerialize}
 * (and relations whose base component has that flag) are omitted from the snapshot.
 * Pass `{ includeSkipSerialize: true }` for a debug dump that includes those types
 * (see {@link World.dump}). The same flag is consulted on deserialize
 * ({@link deserializeWorld}) so dirty or hand-written snapshots cannot reintroduce
 * skip-serialize types into a restored world.
 */
export function serializeWorld(
  archetypes: Archetype[],
  componentEntities: ComponentEntityStore,
  entityIdManager: EntityIdManager,
  options?: SerializeWorldOptions,
): SerializedWorld {
  const includeSkipSerialize = options?.includeSkipSerialize === true;
  // ID cache turns repeated encode work (especially component type IDs) into O(#unique IDs)
  const idCache = new Map<any, any>();

  const entities: SerializedEntity[] = [];

  for (const archetype of archetypes) {
    // Pre-encode this archetype's component type IDs exactly once (big win when many entities share the archetype).
    // null = skipSerialize component — appendSerializedEntities will omit those columns (save path only).
    const encodedComponentTypes: (SerializedEntityId | null)[] = archetype.componentTypes.map((t) =>
      !includeSkipSerialize && shouldSkipSerialize(t) ? null : encodeEntityIdCached(t, idCache),
    );

    // The append method will use the bulk helper internally when a pre-fetched map is supplied.
    // For now we rely on the per-entity fallback inside the archetype (already much cheaper than old dump path).
    archetype.appendSerializedEntities(
      entities,
      (id) => encodeEntityIdCached(id, idCache),
      encodedComponentTypes,
      undefined,
      includeSkipSerialize ? undefined : shouldSkipSerialize,
    );
  }

  const componentEntitiesArr: SerializedEntity[] = [];
  for (const [entityId, components] of componentEntities.entries()) {
    componentEntitiesArr.push({
      id: encodeEntityIdCached(entityId, idCache),
      components: serializeComponentsFromMap(components, idCache, includeSkipSerialize),
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
  includeSkipSerialize = false,
): SerializedComponent[] {
  const result: SerializedComponent[] = [];
  for (const [rawType, value] of components) {
    if (!includeSkipSerialize && shouldSkipSerialize(rawType)) continue;
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
 *
 * Entries whose component type has {@link ComponentOptions.skipSerialize} in the
 * **current process registry** (via {@link shouldSkipSerialize}) are silently
 * dropped for both regular entities and component-entities, matching
 * {@link serializeWorld}. Entity existence is preserved even if every component
 * on that entity was skipped.
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
        if (shouldSkipSerialize(componentType)) continue;
        componentMap.set(componentType, componentEntry.value);
      }

      ctx.componentEntities.initFromSnapshot(entityId, componentMap);
    }
  }

  if (Array.isArray(snapshot.entities)) {
    // Reuse one Map across entities to cut per-entity allocation; cleared between iterations.
    const componentMap = new Map<EntityId<any>, any>();
    // Cache ensureArchetype results by a stable signature string (same as ArchetypeManager).
    // Snapshot entities often share a small set of archetypes, so this avoids repeated
    // filterRegularComponentTypes + normalize + signature work for every entity.
    const archetypeCache = new Map<string, Archetype>();

    for (const entry of snapshot.entities) {
      const entityId = decodeSerializedId(entry.id);
      const componentsArray: SerializedComponent[] = entry.components || [];

      componentMap.clear();
      for (const componentEntry of componentsArray) {
        const componentType = decodeSerializedId(componentEntry.type);
        if (shouldSkipSerialize(componentType)) continue;
        componentMap.set(componentType, componentEntry.value);
      }

      // Signature key from the raw keys (order-independent via sort once for the cache key).
      // ensureArchetype itself still normalizes; we only use this string for local memoization.
      const signatureParts: number[] = [];
      for (const compType of componentMap.keys()) {
        signatureParts.push(compType as number);
      }
      signatureParts.sort((a, b) => a - b);
      const signature = signatureParts.join(",");

      let archetype = archetypeCache.get(signature);
      if (archetype === undefined) {
        archetype = ctx.ensureArchetype(Array.from(componentMap.keys()));
        archetypeCache.set(signature, archetype);
      }

      archetype.addEntity(entityId, componentMap);
      ctx.setEntityToArchetype(entityId, archetype);

      for (const compType of componentMap.keys()) {
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
