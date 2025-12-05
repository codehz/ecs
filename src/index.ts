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
export { World } from "./world";
export type { SerializedWorld } from "./world";

// Query class
export { Query } from "./query";

// System interface
export type { System } from "./system";

// Type utilities
export type { ComponentTuple, ComponentType, LifecycleHook } from "./types";
