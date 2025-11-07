import type { EntityId, WildcardRelationId } from "./entity";

/**
 * Hook types for component lifecycle events
 */
export interface LifecycleHook<T = unknown> {
  /**
   * Called when a component is added to an entity
   */
  onAdded?: (entityId: EntityId, componentType: EntityId<T>, component: T) => void;
  /**
   * Called when a component is removed from an entity
   */
  onRemoved?: (entityId: EntityId, componentType: EntityId<T>) => void;
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
