// ECS Library Entry Point - Public API

// Entity ID types and utilities
export type {
  ComponentId,
  ComponentOptions,
  ComponentRelationId,
  EntityId,
  EntityRelationId,
  RelationId,
  WildcardRelationId,
} from "./core/entity";

export {
  component,
  decodeRelationId,
  getComponentIdByName,
  getComponentNameById,
  isComponentId,
  isEntityId,
  isRelationId,
  isWildcardRelationId,
  relation,
} from "./core/entity";

// World class
export { EntityBuilder } from "./core/builder";
export type { ComponentDef } from "./core/builder";
export type { SerializedComponent, SerializedEntity, SerializedEntityId, SerializedWorld } from "./core/serialization";
export { World } from "./core/world";

// Query class
export { Query } from "./query/query";

// Type utilities
// Type export mappings:
// - Internal LegacyLifecycleHook → External LifecycleHook (single component hooks)
// - Internal LifecycleHook → External MultiLifecycleHook (multi-component hooks)
// - Internal LegacyLifecycleCallback → External LifecycleCallback (single component callbacks)
// - Internal LifecycleCallback → External MultiLifecycleCallback (multi-component callbacks)
export type {
  ComponentTuple,
  ComponentType,
  LegacyLifecycleCallback as LifecycleCallback,
  LegacyLifecycleHook as LifecycleHook,
  LifecycleCallback as MultiLifecycleCallback,
  LifecycleHook as MultiLifecycleHook,
} from "./core/types";
