import type { ComponentId, EntityId } from "./entity";
import { getComponentIdByName, getComponentNameById, getDetailedIdType, relation } from "./entity";

// -----------------------------------------------------------------------------
// Serialization helpers for IDs
// -----------------------------------------------------------------------------

export type SerializedEntityId = number | string | { component: string; target: number | string | "*" };

export type SerializedWorld = {
  version: number;
  entityManager: any;
  entities: SerializedEntity[];
  componentEntities?: SerializedEntity[];
};

export type SerializedEntity = {
  id: SerializedEntityId;
  components: SerializedComponent[];
};

export type SerializedComponent = {
  type: SerializedEntityId;
  value: any;
};

/**
 * Encode an internal EntityId into a SerializedEntityId for snapshots
 */
export function encodeEntityId(id: EntityId<any>): SerializedEntityId {
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
      return { component: componentName || (detailed.componentId as number).toString(), target: detailed.targetId! };
    }
    case "component-relation": {
      const componentName = getComponentNameById(detailed.componentId);
      const targetName = getComponentNameById(detailed.targetId! as ComponentId);
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
