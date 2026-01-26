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
export { EntityBuilder, World } from "./core/world";
export type {
  ComponentDef,
  SerializedComponent,
  SerializedEntity,
  SerializedEntityId,
  SerializedWorld,
} from "./core/world";

// Query class
export { Query } from "./query/query";

// Type utilities
export type { ComponentTuple, ComponentType, LifecycleHook } from "./core/types";
