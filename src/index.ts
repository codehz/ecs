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
export { SingletonHandle } from "./world/singleton";
export type { SingletonHandleOps } from "./world/singleton";
export { World } from "./world/world";

// Query class
export { Query } from "./query/query";

// Type utilities
export type { ComponentTuple, ComponentType, LifecycleCallback, LifecycleHook } from "./types";

// Debug / observability types
export type { DebugStatsCollector, SyncDebugStats } from "./types";

// Sparse / dontFragment flag checks (preferred + legacy aliases for BC)
export {
  isSparseComponent as isDontFragmentComponent,
  isSparseRelation as isDontFragmentRelation,
  isSparseWildcard as isDontFragmentWildcard,
  isSkipSerializeComponent,
  isSparseComponent,
  isSparseRelation,
  isSparseWildcard,
  shouldSkipSerialize,
} from "./component/registry";
