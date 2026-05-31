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
   * An optional human-readable name for the component, used for debugging and
   * serialization.
   *
   * While `name` is **optional** at registration time, omitting it can cause
   * problems when serializing and later deserializing the world:
   *
   * 1. **Cross-session portability**: Without a name, the component is
   *    serialized as a raw numeric ID. Component IDs are allocated sequentially
   *    at registration time, so if the order of `component()` calls changes
   *    between sessions (e.g. due to code refactoring, lazy-loading, or
   *    tree-shaking), those numeric IDs will no longer point to the same
   *    component type, leading to **silent data corruption** on restore.
   *
   * 2. **Runtime warnings**: `encodeEntityId` logs a `console.warn` for every
   *    unnamed component it encounters during `world.serialize()`, which can be
   *    noisy in production when serialization is used for save-games or
   *    snapshots.
   *
   * 3. **Debugging ergonomics**: Named components make serialized snapshots
   *    human-readable (e.g. `"Position"` instead of `42`), which is invaluable
   *    when inspecting save files or network dumps.
   *
   * **Recommendation**: Always provide a `name` for any component that may
   * appear in a serialized world — even if it's just the same string as the
   * variable name.
   *
   * @example
   * ```ts
   * // ✅ Good: explicit name ensures stable serialization
   * const Position = component<{ x: number; y: number }>({ name: "Position" });
   *
   * // ⚠️ Risky: no name — serialization falls back to numeric ID
   * const Velocity = component<{ dx: number; dy: number }>();
   * ```
   */
  name?: string;
  /**
   * If `true`, an entity can have **at most one** relation per base component type.
   * When a new relation with the same base component is added, any existing relations
   * with that base component are **automatically removed** before the new one is applied.
   *
   * **Only applicable to relation components** — components used via
   * `relation(componentId, target)`. Regular (non-relation) components ignore this flag.
   *
   * ## Behavior
   *
   * Exclusive relations enforce a **one-to-one** constraint at the entity level:
   * each entity can hold at most one relation of a given exclusive component type.
   *
   * - **Same base component, different targets**: `set(entity, relation(Comp, A))`
   *   followed by `set(entity, relation(Comp, B))` results in only `(Comp, B)` —
   *   the `(Comp, A)` relation is automatically removed.
   * - **Same base component, same target**: Re-setting the same relation target
   *   simply updates the component value (no extra removal overhead).
   * - **Different exclusive components**: Independent — `exclusive` on `CompA` does
   *   not affect relations using `CompB`.
   *
   * The removal happens **during `world.sync()`**, as part of the command buffer
   * processing, so it respects the same deferred execution model as other structural
   * changes.
   *
   * ## Use cases
   *
   * - **Ownership**: An entity can only be owned by one parent at a time
   *   (`ChildOf` with `exclusive: true`).
   * - **Equipment slots**: An item can only be in one slot at a time
   *   (`EquippedBy` with `exclusive: true`).
   * - **Targeting**: An AI agent can only track one target at a time
   *   (`Targeting` with `exclusive: true`).
   * - **State machines**: An entity can only have one active state from a set
   *   (`ActiveState` with `exclusive: true`).
   *
   * ## Interaction with other options
   *
   * - **`cascadeDelete`**: Compatible. When an exclusive relation uses
   *   `cascadeDelete`, deleting the target entity will both (a) delete the
   *   referencing entity, and (b) the exclusivity constraint prevents the
   *   entity from having multiple cascade-delete relations of the same type.
   * - **`dontFragment`**: Compatible. Exclusivity is enforced at the data level
   *   regardless of whether the archetype is fragmented.
   *
   * @example
   * ```ts
   * // Without exclusive: entity can have multiple ChildOf relations
   * const ChildOf = component();
   * world.set(child, relation(ChildOf, parentA));
   * world.set(child, relation(ChildOf, parentB));
   * world.sync();
   * // child now has TWO ChildOf relations (parentA and parentB)
   * ```
   *
   * @example
   * ```ts
   * // With exclusive: only the last relation survives
   * const ChildOf = component({ exclusive: true });
   * world.set(child, relation(ChildOf, parentA));
   * world.set(child, relation(ChildOf, parentB));
   * world.sync();
   * // child has only (ChildOf, parentB); (ChildOf, parentA) was auto-removed
   * ```
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
   * If true, relations with this component use sparse storage and will not cause
   * archetype fragmentation.
   *
   * **Problem it solves**: By default, each unique relation pair `(component, target)`
   * creates a **separate archetype**. If 100 entities each have a `ChildOf` relation
   * to a different parent, you get 100 archetypes — this is **archetype fragmentation**.
   * Queries that iterate over all entities with a `ChildOf` relation must check all
   * 100 archetypes, which degrades iteration performance and increases memory overhead.
   *
   * **How it works (sparse storage)**: When `sparse` is enabled, the relation's target
   * does **not** contribute to the archetype signature. Entities with different targets
   * for the same relation component share a **single archetype**, and the per-entity
   * target data is stored in a separate side store (historically called
   * `DontFragmentStore`). A wildcard relation marker (`relation(Comp, "*")`) is placed
   * in the archetype component list so queries can still discover matching archetypes.
   *
   * **Use cases**:
   * - **Hierarchy/ownership**: `ChildOf` relations where thousands of entities each
   *   point to different parent entities.
   * - **Dynamic targeting**: Relations where targets change frequently (e.g., AI
   *   targeting, inventory slots) — without `sparse`, each target change would cause
   *   an archetype migration, which is expensive.
   * - **High-cardinality relations**: Any relation where the number of unique targets
   *   is large compared to the number of entities.
   *
   * **Performance implications**:
   * - **Without `sparse`**: Archetype count grows linearly with unique targets.
   *   Each archetype migration (changing a relation target) requires moving the entity's
   *   data between component arrays.
   * - **With `sparse`**: Archetype count stays constant regardless of target diversity.
   *   Changing a relation target is an O(1) update in the sparse side store.
   *   The trade-off is an extra map lookup when accessing the relation data.
   *
   * **Constraints**:
   * - Only applicable to **relation components** (components used with `relation()`).
   * - Wildcard queries (e.g., `relation(Comp, "*")`) still work correctly — the
   *   archetype carries a wildcard marker so queries can discover it.
   * - Works with `exclusive` and `cascadeDelete` simultaneously.
   *
   * **Backward compatibility**: The legacy key `dontFragment` is still accepted and
   * behaves identically. Prefer `sparse` in new code.
   *
   * @example
   * ```ts
   * // Without sparse: 100 entities with different parents = 100 archetypes
   * const ChildOf = component(); // default: fragmentation happens
   *
   * // With sparse: 100 entities with different parents = 1 archetype
   * const ChildOf = component({ sparse: true });
   *
   * for (let i = 0; i < 100; i++) {
   *   const parent = world.new();
   *   const child = world.new();
   *   world.set(child, Position);
   *   world.set(child, relation(ChildOf, parent));
   * }
   * world.sync();
   * // sparse: 1 archetype for all 100 entities
   * // without: 100 archetypes, one per unique parent
   * ```
   *
   * Inspired by Flecs' `DontFragment` trait (now exposed as the clearer `sparse` option).
   */
  sparse?: boolean;
  /**
   * @deprecated Use `sparse: true` instead. This key is kept solely for backward
   * compatibility; `component({ dontFragment: true })` continues to work exactly
   * as before and is equivalent to `sparse: true`.
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
const sparseFlags = new BitSet(COMPONENT_ID_MAX + 1);
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
    // Support both `sparse` (preferred) and the legacy `dontFragment` alias for BC
    if (options.sparse || options.dontFragment) sparseFlags.set(id);
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
  const hasSparse = sparseFlags.has(id);
  return {
    name: hasName ? componentNames[id] : undefined,
    exclusive: hasExclusive ? true : undefined,
    cascadeDelete: hasCascadeDelete ? true : undefined,
    sparse: hasSparse ? true : undefined,
    // For full backward compatibility with code that inspects options.dontFragment
    dontFragment: hasSparse ? true : undefined,
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
 * Check if a component was created with `exclusive: true`.
 *
 * This is a fast O(1) bitset lookup that determines whether the component enforces
 * the one-to-one relation constraint — an entity can have at most one relation of
 * this component type, and setting a new relation target automatically removes the
 * previous one.
 *
 * **Note**: This only checks the component's intrinsic property, not whether a
 * specific entity/relation ID is actually an exclusive relation. For checking
 * runtime relation IDs (including wildcards), use {@link isExclusiveRelation}
 * or {@link isExclusiveWildcard}.
 *
 * @param id - The component ID to check. Must be a plain component ID (1–1023),
 *   not a relation-wrapped ID.
 * @returns `true` if the component was created with `exclusive: true`.
 *
 * @see {@link ComponentOptions.exclusive} for the full explanation of exclusive
 *   relation behavior.
 * @see {@link isExclusiveRelation} for checking specific-target exclusive relations.
 * @see {@link isExclusiveWildcard} for checking wildcard exclusive relations.
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
 * Check if a component is marked as `sparse` (sparse storage for relations).
 *
 * When a component has `sparse: true`, relations using it do not cause archetype
 * fragmentation — entities with different relation targets can share the same
 * archetype. This is a fast O(1) bitset lookup. The legacy `dontFragment` key
 * is still accepted and sets the same internal flag.
 *
 * @param id - The component ID to check.
 * @returns `true` if the component was created with `sparse: true` (or the
 *   legacy `dontFragment: true`).
 *
 * @see {@link ComponentOptions.sparse} for the full explanation of sparse storage.
 */
export function isSparseComponent(id: ComponentId<any>): boolean {
  return sparseFlags.has(id);
}

/**
 * @deprecated Use {@link isSparseComponent} instead. Kept for backward compatibility.
 */
export function isDontFragmentComponent(id: ComponentId<any>): boolean {
  return isSparseComponent(id);
}

/**
 * Generic optimized function to check whether a relation ID's base component
 * has a specific flag in a bitset.
 *
 * Avoids the overhead of `getDetailedIdType` by directly decoding the relation
 * ID and checking: (1) the ID is a valid relation, (2) the component ID is in the
 * valid range, (3) the target satisfies the condition, and (4) the flag bit is set.
 *
 * Used as the fast-path implementation for `isSparseRelation`, `isSparseWildcard`,
 * `isDontFragmentRelation`, `isDontFragmentWildcard`, `isExclusiveRelation`,
 * `isExclusiveWildcard`, and `isCascadeDeleteRelation`.
 *
 * @param id - The entity/relation ID to check.
 * @param flagBitSet - The bitset tracking which component IDs have the flag.
 * @param targetCondition - Predicate on the target ID (e.g., check for wildcard
 *   vs. specific entity target).
 * @returns `true` if the relation's base component has the flag and the target
 *   condition is met.
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
 * Check if an ID is a specific (non-wildcard) relation backed by a `sparse`
 * component (i.e. stored in the side sparse store rather than the archetype).
 *
 * This is used in hot paths (archetype resolution, command processing) to determine
 * whether a relation should be excluded from the archetype signature.
 *
 * @param id - The entity/relation ID to check (must be a relation ID, not a plain
 *   component ID).
 * @returns `true` if this is a specific-target relation (not wildcard) whose base
 *   component was created with `sparse: true` (or legacy `dontFragment: true`).
 *
 * @see {@link isSparseWildcard} for the wildcard variant.
 * @see {@link ComponentOptions.sparse} for the full explanation.
 */
export function isSparseRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(id, sparseFlags, (targetId) => targetId !== WILDCARD_TARGET_ID);
}

/**
 * @deprecated Use {@link isSparseRelation} instead. Kept for backward compatibility.
 */
export function isDontFragmentRelation(id: EntityId<any>): boolean {
  return isSparseRelation(id);
}

/**
 * Check if an ID is a wildcard relation (`relation(Comp, "*")`) backed by a
 * `sparse` component.
 *
 * Wildcard markers for sparse components are placed in the archetype component
 * list so that queries can discover archetypes containing entities with that
 * relation type.
 *
 * @param id - The entity/relation ID to check.
 * @returns `true` if this is a wildcard relation (`"*"` target) whose base
 *   component was created with `sparse: true` (or legacy `dontFragment: true`).
 *
 * @see {@link isSparseRelation} for the specific-target variant.
 * @see {@link ComponentOptions.sparse} for the full explanation.
 */
export function isSparseWildcard(id: EntityId<any>): boolean {
  return checkRelationFlag(id, sparseFlags, (targetId) => targetId === WILDCARD_TARGET_ID);
}

/**
 * @deprecated Use {@link isSparseWildcard} instead. Kept for backward compatibility.
 */
export function isDontFragmentWildcard(id: EntityId<any>): boolean {
  return isSparseWildcard(id);
}

/**
 * Check if an ID is a specific (non-wildcard) relation backed by an `exclusive`
 * component.
 *
 * This is used in hot paths (command buffer processing, relation management) to
 * determine whether setting this relation should trigger automatic removal of
 * other relations with the same base component on the same entity.
 *
 * This is an optimized function that avoids the overhead of `getDetailedIdType`
 * by directly decoding and checking the relation's component ID against the
 * `exclusive` bitset.
 *
 * @param id - The entity/relation ID to check (must be a relation ID, not a plain
 *   component ID).
 * @returns `true` if this is a specific-target relation (not wildcard) whose base
 *   component was created with `exclusive: true`.
 *
 * @see {@link isExclusiveWildcard} for the wildcard variant.
 * @see {@link ComponentOptions.exclusive} for the full explanation of exclusive
 *   relation behavior.
 */
export function isExclusiveRelation(id: EntityId<any>): boolean {
  return checkRelationFlag(id, exclusiveFlags, (targetId) => targetId !== WILDCARD_TARGET_ID);
}

/**
 * Check if an ID is a wildcard relation (`relation(Comp, "*")`) backed by an
 * `exclusive` component.
 *
 * Wildcard markers for exclusive components are used to detect that an archetype
 * may contain exclusive relations, so the runtime can apply exclusivity enforcement
 * when processing relation commands.
 *
 * This is an optimized function that avoids the overhead of `getDetailedIdType`
 * by directly decoding and checking the relation's component ID against the
 * `exclusive` bitset.
 *
 * @param id - The entity/relation ID to check.
 * @returns `true` if this is a wildcard relation (`"*"` target) whose base
 *   component was created with `exclusive: true`.
 *
 * @see {@link isExclusiveRelation} for the specific-target variant.
 * @see {@link ComponentOptions.exclusive} for the full explanation of exclusive
 *   relation behavior.
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
