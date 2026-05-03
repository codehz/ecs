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
} from "./entity";

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
} from "./entity";

// World class
export type {
  SerializedComponent,
  SerializedEntity,
  SerializedEntityId,
  SerializedWorld,
} from "./storage/serialization";
export { EntityBuilder } from "./world/builder";
export type { ComponentDef } from "./world/builder";
export { World } from "./world/world";

// Query class
export { Query } from "./query/query";

// Type utilities
export type { ComponentTuple, ComponentType, LifecycleCallback, LifecycleHook } from "./types";
