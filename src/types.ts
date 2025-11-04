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

/**
 * Type helper for component tuples extracted from EntityId array
 */
export type ComponentTuple<T extends readonly EntityId<any>[]> = {
  readonly [K in keyof T]: T[K] extends WildcardRelationId<infer U>
    ? [EntityId<unknown>, U][]
    : T[K] extends EntityId<infer U>
      ? U
      : never;
};
