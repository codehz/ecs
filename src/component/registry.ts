import { ComponentIdAllocator } from "../entity/manager";
import { decodeRelationRaw } from "../entity/relation";
import type { ComponentId, EntityId } from "../entity/types";
import {
  COMPONENT_ID_MAX,
  ENTITY_ID_START,
  isComponentId,
  isValidComponentId,
  WILDCARD_TARGET_ID,
} from "../entity/types";
import { BitSet } from "../utils/bit-set";

const globalComponentIdAllocator = new ComponentIdAllocator();

const ComponentIdForNames: Map<string, ComponentId<any>> = new Map();

/**
 * Merge function type for combining repeated `set()` values within a single sync batch.
 *
 * When `world.set(entity, componentType, value)` is called **multiple times** for the
 * same entity and same component type **before** the next `world.sync()`, the merge
 * callback is invoked to combine the values instead of simply overwriting. This allows
 * additive or custom composition of component data in a single frame.
 *
 * @typeParam T - The component's value type.
 *
 * @param prev - The value from the **previous** `set()` call (or the merged result of
 *   earlier calls) for this entity/componentType pair within the current sync batch.
 * @param next - The value from the **current** `set()` call being processed.
 *
 * @returns The merged value to be stored. This becomes `prev` if another `set()` for
 *   the same entity and componentType is encountered later in the same batch.
 *
 * @remarks
 * **Idempotency**: Merge functions **must be idempotent**. The ECS does not guarantee
 * that `world.sync()` won't be called multiple times in edge cases (e.g., intermediate
 * syncs during pipeline execution), so the merge result should not depend on call
 * count or non-deterministic state.
 *
 * **Single-batch scope**: Merging only applies to `set()` calls within the **same sync
 * batch** (i.e., between two `world.sync()` calls). After `world.sync()`, the component
 * value is committed to storage, and the next `set()` starts with a fresh `prev` value.
 *
 * @example
 * ```ts
 * // Accumulate damage events in a single frame
 * const DamageEvents = component<DamageEvent[]>({
 *   merge: (prev, next) => [...prev, ...next],
 * });
 *
 * world.set(player, DamageEvents, [{ source: "fire", amount: 10 }]);
 * world.set(player, DamageEvents, [{ source: "ice", amount: 5 }]);
 * // After sync: player has [{ source: "fire", amount: 10 }, { source: "ice", amount: 5 }]
 * ```
 */
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
   *
   * Only applicable to entity-relation components.
   *
   * **Important distinction from default cleanup**:
   * By default, the ECS library **always** cleans up relation components that point
   * to a deleted entity — the relation component is removed from the referencing
   * entity, but the referencing entity itself **survives**. When `cascadeDelete` is
   * enabled, the **entire referencing entity** is deleted, not just the relation
   * component. This deletion is transitive: if entity C references entity B (which
   * is cascade-deleted), entity C will also be deleted, and so on.
   *
   * @example
   * // Without cascadeDelete (default behavior):
   * const ChildOf = component(); // no cascadeDelete
   * world.set(child, relation(ChildOf, parent));
   * world.sync();
   * world.delete(parent);
   * world.sync();
   * // child still exists, but the ChildOf relation is cleaned up
   *
   * @example
   * // With cascadeDelete:
   * const ChildOf = component({ cascadeDelete: true });
   * world.set(child, relation(ChildOf, parent));
   * world.sync();
   * world.delete(parent);
   * world.sync();
   * // child is also deleted (entity deleted, not just relation cleaned up)
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
   * Custom merge behavior for repeated `set()` of the same component type on the
   * same entity within a single sync batch.
   *
   * By default, calling `world.set(entity, comp, value)` multiple times for the same
   * entity and component before `world.sync()` simply overwrites the previous value —
   * the last `set()` wins. When `merge` is provided, the values are combined using
   * your function instead.
   *
   * @remarks
   * **Use cases**:
   * - **Accumulation**: Collecting events, tags, or modifiers that multiple systems
   *   contribute to within the same frame.
   * - **Composition**: Merging partial updates into a single component value (e.g.,
   *   applying multiple `Vec3` deltas to a position).
   * - **Conflict resolution**: Choosing the max/min/latest value when multiple
   *   systems want to set the same component.
   *
   * **Scope**: This only affects `set()` calls on the **same entity** with the **same
   * component type** within **one sync batch** (i.e., between `world.sync()` calls).
   * It does NOT merge values across different entities or across sync boundaries.
   *
   * **Relation support**: If the component is used as a relation (via
   * `relation(componentId, target)`), the merge function also applies per-target.
   * `set(entity, relation(Comp, A), v1)` and `set(entity, relation(Comp, A), v2)`
   * will be merged, but `set(entity, relation(Comp, B), v)` is independent.
   *
   * **Idempotency required**: Your merge function should be idempotent — calling it
   * multiple times with the same inputs must produce the same result. The ECS
   * runtime does not guarantee exactly-once `sync()` execution in all scenarios.
   *
   * **Return value**: The function **must return** the merged value. It should not
   * mutate `prev` or `next` in place unless you intentionally want shared mutable
   * state (which is discouraged).
   *
   * @example
   * ```ts
   * // Collect tags from multiple systems in one frame
   * const Tags = component<string[]>({
   *   merge: (prev, next) => [...prev, ...next],
   * });
   * ```
   *
   * @example
   * ```ts
   * // Only keep the highest priority value
   * const Alert = component<{ level: number; msg: string }>({
   *   merge: (prev, next) => prev.level >= next.level ? prev : next,
   * });
   * ```
   *
   * @example
   * ```ts
   * // Accumulate numeric deltas (e.g., for movement)
   * const Velocity = component<{ x: number; y: number }>({
   *   merge: (prev, next) => ({ x: prev.x + next.x, y: prev.y + next.y }),
   * });
   * ```
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
 * Get the merge callback for a component type (including relation component types).
 *
 * Looks up the base component's merge function, resolving through relation wrappers.
 * For example, if `ChildOf` has a merge function and you pass `relation(ChildOf, parent)`,
 * the same merge function is returned.
 *
 * @param componentType - A raw component ID or a relation-wrapped component type
 *   (e.g., `relation(MyComp, targetEntity)`).
 * @returns The merge callback if one was registered via {@link ComponentOptions.merge},
 *   or `undefined` if no merge was configured for the base component.
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
 * Check if a component is marked as cascade delete.
 *
 * When enabled, deleting the target entity of an entity-relation with this
 * component will cause the **entire referencing entity** to be deleted (not
 * just cleanup of the relation component, which happens by default for all
 * relations).
 *
 * @param id The component ID
 * @returns true if the component is cascade delete, false otherwise
 * @see {@link ComponentOptions.cascadeDelete}
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
 * Check if a relation ID is a cascade delete entity-relation.
 *
 * This is an optimized function that avoids the overhead of getDetailedIdType.
 *
 * Cascade delete only applies to entity-relations (not component-relations or
 * wildcards). When a cascade-delete-marked relation's target entity is deleted,
 * the **entire source entity** (the one holding the relation) is deleted — not
 * just the relation component. Without cascade delete, the relation component
 * is simply removed (which is the default cleanup for all relations when their
 * target is deleted).
 *
 * @param id The entity/relation ID to check
 * @returns true if this is an entity-relation with cascade delete, false otherwise
 * @see {@link ComponentOptions.cascadeDelete}
 */
export function isCascadeDeleteRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(
    id,
    cascadeDeleteFlags,
    (targetId) => targetId !== WILDCARD_TARGET_ID && targetId >= ENTITY_ID_START,
  );
}
