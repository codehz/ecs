import type { EntityId, WildcardRelationId } from "./entity";

/**
 * Hook types for component lifecycle events
 */
export interface LifecycleHook<T = unknown> {
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

export interface MultiLifecycleHook<T extends readonly ComponentType<any>[]> {
  on_init?: (entityId: EntityId, componentTypes: T, components: ComponentTuple<T>) => void;
  on_set?: (entityId: EntityId, componentTypes: T, components: ComponentTuple<T>) => void;
  on_remove?: (entityId: EntityId, componentTypes: T, components: ComponentTuple<T>) => void;
}

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
