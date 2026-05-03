import type { EntityId, WildcardRelationId } from "../entity";
import type { QueryFilter } from "../query/filter";

/**
 * Type-erased component ID, used for runtime container storage
 * @internal
 */
export type AnyComponentId = EntityId<any>;

/**
 * Type-erased entity ID, used for runtime container storage
 * @internal
 */
export type AnyEntityId = EntityId<any>;

/**
 * Lifecycle hook definition for reacting to component additions, updates, and removals.
 * Register hooks with {@link World.hook}.
 */
export interface LifecycleHook<T extends readonly ComponentType<any>[]> {
  /**
   * Called once for each entity that already matches the hook's component types
   * when the hook is first registered, and then for every new matching entity.
   */
  on_init?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
  /**
   * Called whenever a matching entity's component data is updated via `set()`.
   */
  on_set?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
  /**
   * Called whenever a matching entity loses one of the required components
   * or is deleted.
   */
  on_remove?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
}

/**
 * Shorthand callback style for multi-component lifecycle hooks.
 * The same function receives all three events distinguished by the `type` parameter.
 *
 * @example
 * world.hook([Position, Velocity], (type, entityId, position, velocity) => {
 *   if (type === "init") console.log("spawned");
 *   if (type === "set") console.log("updated");
 *   if (type === "remove") console.log("despawned");
 * });
 */
export type LifecycleCallback<T extends readonly ComponentType<any>[]> = (
  type: "init" | "set" | "remove",
  entityId: EntityId,
  ...components: ComponentTuple<T>
) => void;

/**
 * A component type used in queries and hooks.
 * Can be a plain {@link EntityId} or an {@link OptionalEntityId} wrapped with `.optional`.
 */
export type ComponentType<T> = EntityId<T> | OptionalEntityId<T>;

/**
 * Wrapper that marks a component as optional in queries and hooks.
 * When a component is optional, entities missing it are still included in results.
 *
 * @example
 * world.createQuery([Position, { optional: Velocity }]);
 */
export type OptionalEntityId<T> = { optional: EntityId<T> };

export function isOptionalEntityId<T>(type: ComponentType<T>): type is OptionalEntityId<T> {
  return typeof type === "object" && type !== null && "optional" in type;
}

export type ComponentTypeToData<T> = T extends { optional: infer U }
  ? { value: ComponentTypeToData<U> } | undefined
  : T extends WildcardRelationId<infer U>
    ? [EntityId<unknown>, U][]
    : T extends EntityId<infer U>
      ? U
      : never;

/**
 * Maps an array of {@link ComponentType} to their corresponding data tuples.
 * Used by {@link World.query} and {@link Query.forEach} to type component results.
 */
export type ComponentTuple<T extends readonly ComponentType<any>[]> = {
  readonly [K in keyof T]: ComponentTypeToData<T[K]>;
};

export interface LifecycleHookEntry {
  componentTypes: readonly ComponentType<any>[];
  requiredComponents: EntityId<any>[];
  optionalComponents: EntityId<any>[];
  filter: QueryFilter;
  hook: LifecycleHook<any>;
  /** Raw callback function; takes precedence over hook.on_* when present */
  callback?: LifecycleCallback<any>;
  /** Archetypes that match this hook, used for precise cleanup on unsubscription */
  matchedArchetypes?: Set<any>;
}
