import type { EntityId, WildcardRelationId } from "./entity";

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
