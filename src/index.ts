// ECS Library Entry Point - Public API

// Entity ID types and utilities
export type {
  EntityId,
  ComponentId,
  EntityRelationId,
  ComponentRelationId,
  WildcardRelationId,
  RelationId,
  ComponentOptions,
} from "./entity";

export {
  component,
  relation,
  isComponentId,
  isEntityId,
  isRelationId,
  isWildcardRelationId,
  getComponentIdByName,
  getComponentNameById,
  decodeRelationId,
} from "./entity";

// World class
export { World } from "./world";
export type { SerializedWorld } from "./world";

// Query class
export { Query } from "./query";

// System interface
export type { System } from "./system";

// Type utilities
export type { LifecycleHook, ComponentType, ComponentTuple } from "./types";
