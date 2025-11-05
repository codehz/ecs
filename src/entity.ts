/**
 * Unique symbol brand for associating component type information with EntityId
 */
declare const __componentTypeMarker: unique symbol;

/**
 * Unique symbol brand for tagging the kind of EntityId (e.g., 'component', 'entity-relation')
 */
declare const __entityIdTypeTag: unique symbol;

/**
 * Entity ID type for ECS architecture
 * Based on 52-bit integers within safe integer range
 * - Component IDs: 1-1023
 * - Entity IDs: 1024+
 * - Relation IDs: negative numbers encoding component and entity associations
 */
export type EntityId<T = void, U = unknown> = number & {
  readonly [__componentTypeMarker]: T;
  readonly [__entityIdTypeTag]: U;
};

export type ComponentId<T = void> = EntityId<T, "component">;
export type EntityRelationId<T = void> = EntityId<T, "entity-relation">;
export type ComponentRelationId<T = void> = EntityId<T, "component-relation">;
export type WildcardRelationId<T = void> = EntityId<T, "wildcard-relation">;
export type RelationId<T = void> = EntityRelationId<T> | ComponentRelationId<T> | WildcardRelationId<T>;

/**
 * Constants for ID ranges
 */
export const INVALID_COMPONENT_ID = 0;
export const COMPONENT_ID_MAX = 1023;
export const ENTITY_ID_START = 1024;

/**
 * Constants for relation ID encoding
 */
export const RELATION_SHIFT = 2 ** 42;
export const WILDCARD_TARGET_ID = 0;

/**
 * Create a component ID
 * @param id Component identifier (1-1023)
 */
export function createComponentId<T = void>(id: number): ComponentId<T> {
  if (id < 1 || id > COMPONENT_ID_MAX) {
    throw new Error(`Component ID must be between 1 and ${COMPONENT_ID_MAX}`);
  }
  return id as ComponentId<T>;
}

/**
 * Create an entity ID
 * @param id Entity identifier (starting from 1024)
 */
export function createEntityId(id: number): EntityId {
  if (id < ENTITY_ID_START) {
    throw new Error(`Entity ID must be ${ENTITY_ID_START} or greater`);
  }
  return id as EntityId;
}

/**
 * Type for relation ID based on component and target types
 */
// type RelationIdType<T, U> = U extends void ? EntityId<T> : T extends void ? EntityId<U> : EntityId<never>;
type RelationIdType<T, R> =
  R extends ComponentId<infer U>
    ? U extends void
      ? ComponentRelationId<T>
      : ComponentRelationId<T & U>
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
 * Check if an ID is a component ID
 */
export function isComponentId<T>(id: EntityId<T>): id is ComponentId<T> {
  return id >= 1 && id <= COMPONENT_ID_MAX;
}

/**
 * Check if an ID is an entity ID
 */
export function isEntityId<T>(id: EntityId<T>): id is EntityId<T> {
  return id >= ENTITY_ID_START;
}

/**
 * Check if an ID is a relation ID
 */
export function isRelationId<T>(id: EntityId<T>): id is RelationId<T> {
  return id < 0;
}

/**
 * Check if an ID is a wildcard relation id
 */
export function isWildcardRelationId<T>(id: EntityId<T>): id is WildcardRelationId<T> {
  if (!isRelationId(id)) {
    return false;
  }
  const absId = -id;
  const targetId = absId % RELATION_SHIFT;
  return targetId === WILDCARD_TARGET_ID;
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
  if (!isRelationId(relationId)) {
    throw new Error("ID is not a relation ID");
  }
  const absId = -relationId;

  const componentId = Math.floor(absId / RELATION_SHIFT) as ComponentId<any>;
  const targetId = (absId % RELATION_SHIFT) as EntityId<any>;

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

  if (isRelationId(id)) {
    try {
      const decoded = decodeRelationId(id);
      // Validate that componentId and targetId are valid
      if (
        !isComponentId(decoded.componentId) ||
        (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId))
      ) {
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
    } catch (error) {
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
      type: "entity-relation" | "component-relation" | "wildcard-relation";
      componentId: ComponentId<any>;
      targetId: EntityId<any>;
    } {
  if (isComponentId(id)) {
    return { type: "component" };
  }

  if (isEntityId(id)) {
    return { type: "entity" };
  }

  if (isRelationId(id)) {
    try {
      const decoded = decodeRelationId(id);
      // Validate that componentId and targetId are valid
      if (
        !isComponentId(decoded.componentId) ||
        (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId))
      ) {
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
        targetId: decoded.targetId,
      };
    } catch (error) {
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
  if (id === INVALID_COMPONENT_ID) {
    return "Invalid Component ID (0)";
  }

  if (isComponentId(id)) {
    return `Component ID (${id})`;
  }

  if (isEntityId(id)) {
    return `Entity ID (${id})`;
  }

  if (isRelationId(id)) {
    try {
      const decoded = decodeRelationId(id);
      // Validate that both component and target IDs are valid
      if (
        !isComponentId(decoded.componentId) ||
        (decoded.type !== "wildcard" && !isEntityId(decoded.targetId) && !isComponentId(decoded.targetId))
      ) {
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
    } catch (error) {
      return `Invalid Relation ID (${id})`;
    }
  }

  return `Unknown ID (${id})`;
}

/**
 * Entity ID Manager for automatic allocation and freelist recycling
 */
export class EntityIdManager {
  private nextId: number = ENTITY_ID_START;
  private freelist: Set<EntityId> = new Set();

  /**
   * Allocate a new entity ID
   * Uses freelist if available, otherwise increments counter
   */
  allocate(): EntityId {
    if (this.freelist.size > 0) {
      const id = this.freelist.values().next().value!;
      this.freelist.delete(id);
      return id;
    } else {
      const id = this.nextId;
      this.nextId++;
      // Check for overflow (though unlikely in practice)
      if (this.nextId >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Entity ID overflow: reached maximum safe integer");
      }
      return id as EntityId;
    }
  }

  /**
   * Deallocate an entity ID, adding it to the freelist for reuse
   * @param id The entity ID to deallocate
   */
  deallocate(id: EntityId<any>): void {
    if (!isEntityId(id)) {
      throw new Error("Can only deallocate valid entity IDs");
    }
    if (id >= this.nextId) {
      throw new Error("Cannot deallocate an ID that was never allocated");
    }
    this.freelist.add(id);
  }

  /**
   * Get the current freelist size (for debugging/monitoring)
   */
  getFreelistSize(): number {
    return this.freelist.size;
  }

  /**
   * Get the next ID that would be allocated (for debugging)
   */
  getNextId(): number {
    return this.nextId;
  }
}

/**
 * Component ID Manager for automatic allocation
 * Components are typically registered once and not recycled
 */
export class ComponentIdManager {
  private nextId: number = 1;

  /**
   * Allocate a new component ID
   * Increments counter sequentially from 1
   */
  allocate<T = void>(): ComponentId<T> {
    if (this.nextId > COMPONENT_ID_MAX) {
      throw new Error(`Component ID overflow: maximum ${COMPONENT_ID_MAX} components allowed`);
    }
    const id = this.nextId;
    this.nextId++;
    return id as ComponentId<T>;
  }

  /**
   * Get the next ID that would be allocated (for debugging)
   */
  getNextId(): number {
    return this.nextId;
  }

  /**
   * Check if more component IDs are available
   */
  hasAvailableIds(): boolean {
    return this.nextId <= COMPONENT_ID_MAX;
  }
}
