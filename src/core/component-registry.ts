import { BitSet } from "../utils/bit-set";
import { ComponentIdAllocator } from "./entity-manager";
import { decodeRelationRaw } from "./entity-relation";
import type { ComponentId, EntityId } from "./entity-types";
import {
  COMPONENT_ID_MAX,
  ENTITY_ID_START,
  isComponentId,
  isValidComponentId,
  WILDCARD_TARGET_ID,
} from "./entity-types";

const globalComponentIdAllocator = new ComponentIdAllocator();

const ComponentIdForNames: Map<string, ComponentId<any>> = new Map();
type ComponentMerge<T = any> = (prev: T, next: T) => T;

/**
 * Component options that define intrinsic properties
 */
export interface ComponentOptions<T = any> {
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
  /**
   * Custom merge behavior for repeated set() of the same componentType in a single sync batch.
   */
  merge?: ComponentMerge<T>;
}

// Array for component names (Component ID range: 1-1023)
const componentNames: (string | undefined)[] = new Array(COMPONENT_ID_MAX + 1);

// BitSets for fast component option checks (Component ID range: 1-1023)
const exclusiveFlags = new BitSet(COMPONENT_ID_MAX + 1);
const cascadeDeleteFlags = new BitSet(COMPONENT_ID_MAX + 1);
const dontFragmentFlags = new BitSet(COMPONENT_ID_MAX + 1);
const componentMerges: (ComponentMerge<any> | undefined)[] = new Array(COMPONENT_ID_MAX + 1);

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
export function component<T = void>(nameOrOptions?: string | ComponentOptions<T>): ComponentId<T> {
  const id = globalComponentIdAllocator.allocate<T>();

  let name: string | undefined;
  let options: ComponentOptions<T> | undefined;

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

    componentNames[id] = name;
    ComponentIdForNames.set(name, id);
  }

  // Register options if provided
  if (options) {
    // Set bitset flags for fast lookup
    if (options.exclusive) exclusiveFlags.set(id);
    if (options.cascadeDelete) cascadeDeleteFlags.set(id);
    if (options.dontFragment) dontFragmentFlags.set(id);
    if (options.merge) componentMerges[id] = options.merge;
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
  return componentNames[id];
}

/**
 * Get component options by its ID
 * @param id The component ID
 * @returns The component options
 */
export function getComponentOptions<T = any>(id: ComponentId<T>): ComponentOptions<T> {
  if (!isComponentId(id)) {
    throw new Error("Invalid component ID");
  }
  const hasName = componentNames[id] !== undefined;
  const hasExclusive = exclusiveFlags.has(id);
  const hasCascadeDelete = cascadeDeleteFlags.has(id);
  const hasDontFragment = dontFragmentFlags.has(id);
  return {
    name: hasName ? componentNames[id] : undefined,
    exclusive: hasExclusive ? true : undefined,
    cascadeDelete: hasCascadeDelete ? true : undefined,
    dontFragment: hasDontFragment ? true : undefined,
    merge: componentMerges[id] as ComponentMerge<T> | undefined,
  };
}

function getBaseComponentId(componentType: EntityId<any>): ComponentId<any> | undefined {
  if (isComponentId(componentType)) {
    return componentType;
  }

  const decoded = decodeRelationRaw(componentType);
  if (decoded === null) return undefined;
  return isValidComponentId(decoded.componentId) ? (decoded.componentId as ComponentId<any>) : undefined;
}

/**
 * Get merge callback for a componentType (including relation component types).
 * Returns undefined if the base component has no merge callback.
 */
export function getComponentMerge<T = any>(componentType: EntityId<any>): ComponentMerge<T> | undefined {
  const baseComponentId = getBaseComponentId(componentType);
  if (baseComponentId === undefined) return undefined;
  return componentMerges[baseComponentId] as ComponentMerge<T> | undefined;
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
