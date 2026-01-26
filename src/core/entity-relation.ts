import type {
  ComponentId,
  ComponentRelationId,
  EntityId,
  EntityRelationId,
  RelationId,
  WildcardRelationId,
} from "./entity-types";
import {
  ENTITY_ID_START,
  isComponentId,
  isEntityId,
  isValidComponentId,
  RELATION_SHIFT,
  WILDCARD_TARGET_ID,
} from "./entity-types";

/**
 * Internal function to decode a relation ID into raw component and target IDs
 * @param id The EntityId to decode
 * @returns Object with componentId and targetId, or null if not a relation
 */
export function decodeRelationRaw(id: EntityId<any>): { componentId: number; targetId: number } | null {
  if (id >= 0) return null;
  const absId = -id;
  const componentId = Math.floor(absId / RELATION_SHIFT);
  const targetId = absId % RELATION_SHIFT;
  return { componentId, targetId };
}

/**
 * Type for relation ID based on component and target types
 */
type RelationIdType<T, R> =
  R extends ComponentId<infer U>
    ? U extends void
      ? ComponentRelationId<T>
      : ComponentRelationId<T extends void ? U : T>
    : R extends EntityId<any>
      ? EntityRelationId<T>
      : never;

/**
 * Create a relation ID by associating a component with another ID (entity or component)
 * @param componentId The component ID (0-1023)
 * @param targetId The target ID (entity, component, or '*' for wildcard)
 */
export function relation<T>(componentId: ComponentId<T>, targetId: "*"): WildcardRelationId<T>;
export function relation<T, R extends EntityId<any>>(componentId: ComponentId<T>, targetId: R): RelationIdType<T, R>;
export function relation<T>(componentId: ComponentId<T>, targetId: EntityId<any> | "*"): EntityId<any> {
  if (!isComponentId(componentId)) {
    throw new Error("First argument must be a valid component ID");
  }

  let actualTargetId: number;
  if (targetId === "*") {
    actualTargetId = WILDCARD_TARGET_ID;
  } else {
    if (!isEntityId(targetId) && !isComponentId(targetId)) {
      throw new Error("Second argument must be a valid entity ID, component ID, or '*'");
    }
    actualTargetId = targetId;
  }

  // Encode: negative number with component_id * 2^42 + target_id
  return -(componentId * RELATION_SHIFT + actualTargetId) as EntityId<any>;
}

/**
 * Check if an ID is a wildcard relation id
 */
export function isWildcardRelationId<T>(id: EntityId<T>): id is WildcardRelationId<T> {
  const decoded = decodeRelationRaw(id);
  return decoded !== null && decoded.targetId === WILDCARD_TARGET_ID;
}

/**
 * Decode a relation ID into component and target IDs
 * @param relationId The relation ID (must be negative)
 * @returns Object with componentId, targetId, and relation type
 */
export function decodeRelationId(relationId: RelationId<any>): {
  componentId: ComponentId<any>;
  targetId: EntityId<any>;
  type: "entity" | "component" | "wildcard";
} {
  const decoded = decodeRelationRaw(relationId);
  if (decoded === null) {
    throw new Error("ID is not a relation ID");
  }

  const { componentId: rawComponentId, targetId: rawTargetId } = decoded;
  if (!isValidComponentId(rawComponentId)) {
    throw new Error("Invalid component ID in relation");
  }

  const componentId = rawComponentId as ComponentId<any>;
  const targetId = rawTargetId as EntityId<any>;

  // Determine type based on targetId range
  if (targetId === WILDCARD_TARGET_ID) {
    return { componentId, targetId, type: "wildcard" };
  } else if (isEntityId(targetId)) {
    return { componentId, targetId, type: "entity" };
  } else if (isComponentId(targetId)) {
    return { componentId, targetId, type: "component" };
  } else {
    throw new Error("Invalid target ID in relation");
  }
}

/**
 * Get the string representation of an ID type
 */
export function getIdType(
  id: EntityId<any>,
): "component" | "entity" | "entity-relation" | "component-relation" | "wildcard-relation" | "invalid" {
  if (isComponentId(id)) return "component";
  if (isEntityId(id)) return "entity";

  if (id < 0) {
    try {
      const decoded = decodeRelationId(id as RelationId<any>);
      // Validate that componentId and targetId are valid (decodeRelationId already checks componentId)
      if (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId)) {
        return "invalid";
      }
      switch (decoded.type) {
        case "entity":
          return "entity-relation";
        case "component":
          return "component-relation";
        case "wildcard":
          return "wildcard-relation";
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      return "invalid"; // fallback for invalid relation IDs
    }
  }

  return "invalid"; // fallback for unknown/invalid IDs
}

/**
 * Get detailed type information for an EntityId
 * @param id The EntityId to analyze
 * @returns Detailed type information including relation subtypes
 */
export function getDetailedIdType(id: EntityId<any>):
  | {
      type: "component" | "entity" | "invalid";
      componentId?: never;
      targetId?: never;
    }
  | {
      type: "entity-relation" | "wildcard-relation";
      componentId: ComponentId<any>;
      targetId: EntityId<any>;
    }
  | {
      type: "component-relation";
      componentId: ComponentId<any>;
      targetId: ComponentId<any>;
    } {
  if (isComponentId(id)) {
    return { type: "component" };
  }

  if (isEntityId(id)) {
    return { type: "entity" };
  }

  if (id < 0) {
    try {
      const decoded = decodeRelationId(id as RelationId<any>);
      // Validate that targetId is valid (decodeRelationId already checks componentId)
      if (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId)) {
        return { type: "invalid" };
      }
      let type: "entity-relation" | "component-relation" | "wildcard-relation";

      switch (decoded.type) {
        case "entity":
          type = "entity-relation";
          break;
        case "component":
          type = "component-relation";
          break;
        case "wildcard":
          type = "wildcard-relation";
          break;
      }

      return {
        type,
        componentId: decoded.componentId,
        targetId: decoded.targetId as any,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      // Invalid relation ID
      return { type: "invalid" };
    }
  }

  // Unknown/invalid ID
  return { type: "invalid" };
}

/**
 * Inspect an EntityId and return a human-readable string representation
 * @param id The EntityId to inspect
 * @returns A friendly string representation of the ID
 */
export function inspectEntityId(id: EntityId<any>): string {
  if (id === 0) {
    return "Invalid Component ID (0)";
  }

  if (isComponentId(id)) {
    return `Component ID (${id})`;
  }

  if (isEntityId(id)) {
    return `Entity ID (${id})`;
  }

  if (id < 0) {
    try {
      const decoded = decodeRelationId(id as RelationId<any>);
      // Validate that targetId is valid (decodeRelationId already checks componentId)
      if (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId)) {
        return `Invalid Relation ID (${id})`;
      }
      const componentStr = `Component ID (${decoded.componentId})`;
      const targetStr =
        decoded.type === "entity"
          ? `Entity ID (${decoded.targetId})`
          : decoded.type === "component"
            ? `Component ID (${decoded.targetId})`
            : "Wildcard (*)";
      return `Relation ID: ${componentStr} -> ${targetStr}`;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      return `Invalid Relation ID (${id})`;
    }
  }

  return `Unknown ID (${id})`;
}

/**
 * Get the componentId from a relation ID without fully decoding the relation.
 * Returns undefined for non-relation IDs or invalid component IDs.
 */
export function getComponentIdFromRelationId<T>(id: EntityId<T>): ComponentId<T> | undefined {
  const decoded = decodeRelationRaw(id);
  if (decoded === null || !isValidComponentId(decoded.componentId)) return undefined;
  return decoded.componentId as ComponentId<T>;
}

/**
 * Get the targetId from a relation ID without fully decoding the relation.
 * Returns undefined for non-relation IDs.
 */
export function getTargetIdFromRelationId(id: EntityId<any>): EntityId<any> | undefined {
  const decoded = decodeRelationRaw(id);
  return decoded?.targetId as EntityId<any>;
}

/**
 * Check if an ID is an entity-relation (relation targeting an entity, not a component or wildcard)
 */
export function isEntityRelation(id: EntityId<any>): boolean {
  const decoded = decodeRelationRaw(id);
  return decoded !== null && decoded.targetId >= ENTITY_ID_START;
}

/**
 * Check if an ID is a component-relation (relation targeting a component)
 */
export function isComponentRelation(id: EntityId<any>): boolean {
  const decoded = decodeRelationRaw(id);
  return decoded !== null && isValidComponentId(decoded.targetId);
}

/**
 * Check if an ID is any type of relation (entity, component, or wildcard)
 */
export function isAnyRelation(id: EntityId<any>): boolean {
  return id < 0;
}
