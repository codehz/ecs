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
export type { ComponentTuple, ComponentType, LifecycleHook } from "./core/types";
