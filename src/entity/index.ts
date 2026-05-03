// Re-export all types and functions from split modules for backwards compatibility

// Entity types and constants
export type {
  ComponentId,
  ComponentRelationId,
  EntityId,
  EntityRelationId,
  RelationId,
  WildcardRelationId,
} from "./types";

export {
  COMPONENT_ID_MAX,
  ENTITY_ID_START,
  INVALID_COMPONENT_ID,
  RELATION_SHIFT,
  WILDCARD_TARGET_ID,
  createComponentId,
  createEntityId,
  isComponentId,
  isEntityId,
  isRelationId,
  isValidComponentId,
} from "./types";

// Relation functions
export {
  decodeRelationId,
  decodeRelationRaw,
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  getTargetIdFromRelationId,
  inspectEntityId,
  isAnyRelation,
  isComponentRelation,
  isEntityRelation,
  isWildcardRelationId,
  relation,
} from "./relation";

// Entity and component managers
export { ComponentIdAllocator, EntityIdManager } from "./manager";

// Component registry
export type { ComponentOptions } from "../component/registry";

export {
  component,
  getComponentIdByName,
  getComponentMerge,
  getComponentNameById,
  getComponentOptions,
  isCascadeDeleteComponent,
  isCascadeDeleteRelation,
  isDontFragmentComponent,
  isDontFragmentRelation,
  isDontFragmentWildcard,
  isExclusiveComponent,
  isExclusiveRelation,
  isExclusiveWildcard,
} from "../component/registry";
