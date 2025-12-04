import { BitSet } from "./bit-set";

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
 * Internal function to decode a relation ID into raw component and target IDs
 * @param id The EntityId to decode
 * @returns Object with componentId and targetId, or null if not a relation
 */
function decodeRelationRaw(id: EntityId<any>): { componentId: number; targetId: number } | null {
  if (id >= 0) return null;
  const absId = -id;
  const componentId = Math.floor(absId / RELATION_SHIFT);
  const targetId = absId % RELATION_SHIFT;
  return { componentId, targetId };
}

/**
 * Check if a component ID is valid (1-1023)
 */
function isValidComponentId(componentId: number): boolean {
  return componentId >= 1 && componentId <= COMPONENT_ID_MAX;
}

/**
 * Create a component ID
 * @param id Component identifier (1-1023)
 * @internal This function is for internal use and testing only. Use `component()` to create components.
 * @see component
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

  if (isRelationId(id)) {
    try {
      const decoded = decodeRelationId(id);
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

  if (isRelationId(id)) {
    try {
      const decoded = decodeRelationId(id);
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

  /**
   * Serialize internal state for persistence.
   * Returns a plain object representing allocator state. Values may be non-JSON-serializable.
   */
  serializeState(): { nextId: number; freelist: number[] } {
    return { nextId: this.nextId, freelist: Array.from(this.freelist) };
  }

  /**
   * Restore internal state from a previously-serialized object.
   * Overwrites the current nextId and freelist.
   */
  deserializeState(state: { nextId: number; freelist?: number[] }): void {
    if (typeof state.nextId !== "number") {
      throw new Error("Invalid state for EntityIdManager.deserializeState");
    }
    this.nextId = state.nextId;
    this.freelist = new Set((state.freelist || []) as EntityId[]);
  }
}

/**
 * Component ID Manager for automatic allocation
 * Components are typically registered once and not recycled
 */
export class ComponentIdAllocator {
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

const globalComponentIdAllocator = new ComponentIdAllocator();

const ComponentNames: Map<ComponentId<any>, string> = new Map();
const ComponentIdForNames: Map<string, ComponentId<any>> = new Map();

/**
 * Component options that define intrinsic properties
 */
export interface ComponentOptions {
  /**
   * Optional name for the component (for serialization/debugging)
   */
  name?: string;
  /**
   * If true, an entity can have at most one relation per base component.
   * When adding a new relation with the same base component, any existing relations
   * with that base component are automatically removed.
   * Only applicable to relation components.
   */
  exclusive?: boolean;
  /**
   * If true, when a relation target entity is deleted, all entities that reference
   * it through this component will also be deleted (cascade delete).
   * Only applicable to entity-relation components.
   */
  cascadeDelete?: boolean;
  /**
   * If true, relations with this component will not cause archetype fragmentation.
   * Entities with different target entities for this relation component will be stored
   * in the same archetype, preventing fragmentation when there are many different targets.
   * Only applicable to relation components.
   * Inspired by Flecs' DontFragment trait.
   */
  dontFragment?: boolean;
}

const ComponentOptions: Map<ComponentId<any>, ComponentOptions> = new Map();

// BitSets for fast component option checks (Component ID range: 1-1023)
const exclusiveFlags = new BitSet(COMPONENT_ID_MAX + 1);
const cascadeDeleteFlags = new BitSet(COMPONENT_ID_MAX + 1);
const dontFragmentFlags = new BitSet(COMPONENT_ID_MAX + 1);

/**
 * Allocate a new component ID from the global allocator.
 * @param nameOrOptions Optional name for the component (for serialization/debugging) or options object
 * @returns The allocated component ID
 * @example
 * // Just a name
 * const Position = component<Position>("Position");
 *
 * // With options
 * const ChildOf = component({ exclusive: true, cascadeDelete: true });
 *
 * // With name and options
 * const ChildOf = component({ name: "ChildOf", exclusive: true });
 */
export function component<T = void>(nameOrOptions?: string | ComponentOptions): ComponentId<T> {
  const id = globalComponentIdAllocator.allocate<T>();

  let name: string | undefined;
  let options: ComponentOptions | undefined;

  // Parse the parameter
  if (typeof nameOrOptions === "string") {
    name = nameOrOptions;
  } else if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
    options = nameOrOptions;
    name = options.name;
  }

  // Register name if provided
  if (name) {
    if (ComponentIdForNames.has(name)) {
      throw new Error(`Component name "${name}" is already registered`);
    }

    ComponentNames.set(id, name);
    ComponentIdForNames.set(name, id);
  }

  // Register options if provided
  if (options) {
    ComponentOptions.set(id, options);
    // Set bitset flags for fast lookup
    if (options.exclusive) exclusiveFlags.set(id);
    if (options.cascadeDelete) cascadeDeleteFlags.set(id);
    if (options.dontFragment) dontFragmentFlags.set(id);
  }

  return id;
}

/**
 * Get a component ID by its registered name
 * @param name The component name
 * @returns The component ID if found, undefined otherwise
 */
export function getComponentIdByName(name: string): ComponentId<any> | undefined {
  return ComponentIdForNames.get(name);
}

/** Get a component name by its ID
 * @param id The component ID
 * @returns The component name if found, undefined otherwise
 */
export function getComponentNameById(id: ComponentId<any>): string | undefined {
  return ComponentNames.get(id);
}

/**
 * Get component options by its ID
 * @param id The component ID
 * @returns The component options if found, undefined otherwise
 */
export function getComponentOptions(id: ComponentId<any>): ComponentOptions | undefined {
  return ComponentOptions.get(id);
}

/**
 * Check if a component is marked as exclusive
 * @param id The component ID
 * @returns true if the component is exclusive, false otherwise
 */
export function isExclusiveComponent(id: ComponentId<any>): boolean {
  return exclusiveFlags.has(id);
}

/**
 * Check if a component is marked as cascade delete
 * @param id The component ID
 * @returns true if the component is cascade delete, false otherwise
 */
export function isCascadeDeleteComponent(id: ComponentId<any>): boolean {
  return cascadeDeleteFlags.has(id);
}

/**
 * Check if a component is marked as dontFragment
 * @param id The component ID
 * @returns true if the component is dontFragment, false otherwise
 */
export function isDontFragmentComponent(id: ComponentId<any>): boolean {
  return dontFragmentFlags.has(id);
}

/**
 * Generic function to check relation flags with specific target conditions
 * @param id The entity/relation ID to check
 * @param flagBitSet The bitset for the flag
 * @param targetCondition Function to check target ID condition
 * @returns true if the condition is met, false otherwise
 */
function checkRelationFlag(
  id: EntityId<any>,
  flagBitSet: BitSet,
  targetCondition: (targetId: number) => boolean,
): boolean {
  const decoded = decodeRelationRaw(id);
  if (decoded === null) return false;
  const { componentId, targetId } = decoded;
  return isValidComponentId(componentId) && targetCondition(targetId) && flagBitSet.has(componentId);
}

/**
 * Check if a relation ID is a dontFragment relation (entity-relation or component-relation with dontFragment component)
 * This is an optimized function that avoids the overhead of getDetailedIdType
 * @param id The entity/relation ID to check
 * @returns true if this is a dontFragment relation, false otherwise
 */
export function isDontFragmentRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(id, dontFragmentFlags, (targetId) => targetId !== WILDCARD_TARGET_ID);
}

/**
 * Check if an ID is a wildcard relation with dontFragment component
 * This is an optimized function for filtering archetype component types
 * @param id The entity/relation ID to check
 * @returns true if this is a wildcard relation with dontFragment component, false otherwise
 */
export function isDontFragmentWildcard(id: EntityId<any>): boolean {
  return checkRelationFlag(id, dontFragmentFlags, (targetId) => targetId === WILDCARD_TARGET_ID);
}

/**
 * Check if a relation ID is an exclusive relation (entity-relation or component-relation with exclusive component)
 * This avoids the full getDetailedIdType overhead for hot paths
 * @param id The entity/relation ID to check
 * @returns true if this is an exclusive relation, false otherwise
 */
export function isExclusiveRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(id, exclusiveFlags, (targetId) => targetId !== WILDCARD_TARGET_ID);
}

/**
 * Check if a relation ID is a wildcard relation with exclusive component
 */
export function isExclusiveWildcard(id: EntityId<any>): boolean {
  return checkRelationFlag(id, exclusiveFlags, (targetId) => targetId === WILDCARD_TARGET_ID);
}

/**
 * Check if a relation ID is a cascade delete entity-relation
 * This is an optimized function that avoids the overhead of getDetailedIdType
 * Note: Cascade delete only applies to entity-relations (not component-relations or wildcards)
 * @param id The entity/relation ID to check
 * @returns true if this is an entity-relation with cascade delete, false otherwise
 */
export function isCascadeDeleteRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(
    id,
    cascadeDeleteFlags,
    (targetId) => targetId !== WILDCARD_TARGET_ID && targetId >= ENTITY_ID_START,
  );
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
