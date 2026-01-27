import type { EntityId, WildcardRelationId } from "./entity";

/**
 * Hook types for component lifecycle events
 */
export interface LegacyLifecycleHook<T = unknown> {
  /**
   * Called when a component is added to an entity
   */
  on_init?: (entityId: EntityId, componentType: EntityId<T>, component: T) => void;
  /**
   * Called when a component is added to an entity
   */
  on_set?: (entityId: EntityId, componentType: EntityId<T>, component: T) => void;
  /**
   * Called when a component is deleted from an entity
   */
  on_remove?: (entityId: EntityId, componentType: EntityId<T>, component: T) => void;
}

export interface LifecycleHook<T extends readonly ComponentType<any>[]> {
  on_init?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
  on_set?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
  on_remove?: (entityId: EntityId, ...components: ComponentTuple<T>) => void;
}

/**
 * Convenience function type for single component lifecycle events
 * Combines on_init, on_set, and on_remove into a single callback
 */
export type LegacyLifecycleCallback<T = unknown> = (
  type: "init" | "set" | "remove",
  entityId: EntityId,
  componentType: EntityId<T>,
  component: T,
) => void;

/**
 * Convenience function type for multi-component lifecycle events
 * Combines on_init, on_set, and on_remove into a single callback
 */
export type LifecycleCallback<T extends readonly ComponentType<any>[]> = (
  type: "init" | "set" | "remove",
  entityId: EntityId,
  ...components: ComponentTuple<T>
) => void;

export type ComponentType<T> = EntityId<T> | OptionalEntityId<T>;

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
 * Type helper for component tuples extracted from EntityId array
 */
export type ComponentTuple<T extends readonly ComponentType<any>[]> = {
  readonly [K in keyof T]: ComponentTypeToData<T[K]>;
};

export interface MultiHookEntry {
  componentTypes: readonly ComponentType<any>[];
  requiredComponents: EntityId<any>[];
  optionalComponents: EntityId<any>[];
  hook: LifecycleHook<any>;
}
