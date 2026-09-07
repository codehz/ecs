import type { ComponentId, EntityId } from "../entity";
import { getComponentIdByName, getComponentNameById, getDetailedIdType, relation } from "../entity";

// -----------------------------------------------------------------------------
// Serialization helpers for IDs
// -----------------------------------------------------------------------------

export type SerializedEntityId = number | string | { component: string; target: number | string | "*" };

/**
 * Serialized state of EntityIdManager
 */
export interface SerializedEntityIdManager {
  nextId: number;
  freelist?: number[];
}

export type SerializedWorldV1 = {
  version: number;
  entityManager: SerializedEntityIdManager;
  entities: SerializedEntity[];
  componentEntities?: SerializedEntity[];
};

/**
 * Packed column for {@link SerializedWorldV2}.
 *
 * - `unknown[]` — no `undefined` slots (JSON-safe as-is)
 * - `null` — every slot is `undefined` (wildcard markers, void tags)
 * - `{ v, u }` — mixed; `u` is indices whose values are `undefined`
 *   (`v[i]` is a JSON placeholder `null` at those indices)
 *
 * Needed because `JSON.stringify` turns `undefined` array slots into `null`,
 * colliding with legitimate `null` component values. v1 avoided this by
 * omitting the `value` key on `{ type, value }` objects.
 */
export type SerializedColumn = unknown[] | null | { v: unknown[]; u: number[] };

export type SerializedArchetype = {
  types: SerializedEntityId[];
  entities: SerializedEntityId[];
  columns: SerializedColumn[];
};

export type SerializedSparseRelationTable = {
  component: SerializedEntityId;
  sources: SerializedEntityId[];
  targets: SerializedEntityId[];
  values?: SerializedColumn;
};

export type SerializedWorldV2 = {
  version: number;
  entityManager: SerializedEntityIdManager;
  archetypes: SerializedArchetype[];
  sparseRelations?: SerializedSparseRelationTable[];
  componentEntities?: SerializedEntity[];
};

/**
 * In-memory world snapshot. `world.serialize()` / `world.dump()` emit
 * {@link SerializedWorldV2} (columnar). {@link World} still restores
 * {@link SerializedWorldV1} (entity-oriented) snapshots.
 */
export type SerializedWorld = SerializedWorldV1 | SerializedWorldV2;

export type SerializedEntity = {
  id: SerializedEntityId;
  components: SerializedComponent[];
};

export type SerializedComponent = {
  type: SerializedEntityId;
  value: any;
};

export function isSerializedWorldV2(snapshot: SerializedWorld): snapshot is SerializedWorldV2 {
  return "archetypes" in snapshot;
}

/**
 * Core encoding logic (no cache). Extracted so cached wrapper can reuse it without duplication.
 */
function encodeEntityIdCore(id: EntityId<any>): SerializedEntityId {
  const detailed = getDetailedIdType(id);
  switch (detailed.type) {
    case "component": {
      const name = getComponentNameById(id as ComponentId);
      if (!name) {
        // Warn if component doesn't have a name; keep numeric fallback
        console.warn(`Component ID ${id} has no registered name, serializing as number`);
      }
      return name || (id as number);
    }
    case "entity-relation": {
      const componentName = getComponentNameById(detailed.componentId);
      if (!componentName) {
        console.warn(`Component ID ${detailed.componentId} in relation has no registered name`);
      }
      // Safe: targetId is guaranteed to exist for entity-relation type
      return { component: componentName || (detailed.componentId as number).toString(), target: detailed.targetId };
    }
    case "component-relation": {
      const componentName = getComponentNameById(detailed.componentId);
      // Safe: targetId is guaranteed to exist for component-relation type
      const targetName = getComponentNameById(detailed.targetId as ComponentId);
      if (!componentName) {
        console.warn(`Component ID ${detailed.componentId} in relation has no registered name`);
      }
      if (!targetName) {
        console.warn(`Target component ID ${detailed.targetId} in relation has no registered name`);
      }
      return {
        component: componentName || (detailed.componentId as number).toString(),
        target: targetName || (detailed.targetId as number),
      };
    }
    case "wildcard-relation": {
      const componentName = getComponentNameById(detailed.componentId);
      if (!componentName) {
        console.warn(`Component ID ${detailed.componentId} in relation has no registered name`);
      }
      return { component: componentName || (detailed.componentId as number).toString(), target: "*" };
    }
    default:
      return id as number;
  }
}

/**
 * Encode an internal EntityId into a SerializedEntityId for snapshots.
 * Use encodeEntityIdCached when serializing many entities to benefit from memoization
 * of repeated component/relation type IDs.
 */
export function encodeEntityId(id: EntityId<any>): SerializedEntityId {
  return encodeEntityIdCore(id);
}

/**
 * Encode an EntityId, using an optional cache Map to avoid repeated getDetailedIdType
 * + name lookup work for IDs that appear many times (typical during full world snapshot).
 */
export function encodeEntityIdCached(
  id: EntityId<any>,
  cache?: Map<EntityId<any>, SerializedEntityId>,
): SerializedEntityId {
  if (cache) {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const result = encodeEntityIdCore(id);
    cache.set(id, result);
    return result;
  }
  return encodeEntityIdCore(id);
}

/**
 * Decode a SerializedEntityId back into an internal EntityId
 */
export function decodeSerializedId(sid: SerializedEntityId): EntityId<any> {
  if (typeof sid === "number") {
    return sid as EntityId<any>;
  }
  if (typeof sid === "string") {
    const id = getComponentIdByName(sid);
    if (id === undefined) {
      const num = parseInt(sid, 10);
      if (!isNaN(num)) return num as EntityId<any>;
      throw new Error(`Unknown component name in snapshot: ${sid}`);
    }
    return id;
  }
  if (typeof sid === "object" && sid !== null && typeof sid.component === "string") {
    let compId = getComponentIdByName(sid.component);
    if (compId === undefined) {
      const num = parseInt(sid.component, 10);
      if (!isNaN(num)) compId = num as ComponentId;
    }
    if (compId === undefined) {
      throw new Error(`Unknown component name in snapshot: ${sid.component}`);
    }

    if (sid.target === "*") {
      return relation(compId, "*");
    }

    let targetId: EntityId<any>;
    if (typeof sid.target === "string") {
      const tid = getComponentIdByName(sid.target);
      if (tid === undefined) {
        const num = parseInt(sid.target, 10);
        if (!isNaN(num)) targetId = num as EntityId<any>;
        else throw new Error(`Unknown target component name in snapshot: ${sid.target}`);
      } else {
        targetId = tid;
      }
    } else {
      targetId = sid.target as EntityId<any>;
    }
    return relation(compId, targetId as any);
  }
  throw new Error(`Invalid ID in snapshot: ${JSON.stringify(sid)}`);
}
