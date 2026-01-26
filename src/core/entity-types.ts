/**
 * Unique symbol brand for associating component type information with EntityId
 */
declare const __componentTypeMarker: unique symbol;

/**
 * Unique symbol brand for tagging the kind of EntityId (e.g., 'component', 'entity-relation')
 */
declare const __entityIdTypeTag: unique symbol;

/**
 * Entity ID type for ECS architecture
 * Based on 52-bit integers within safe integer range
 * - Component IDs: 1-1023
 * - Entity IDs: 1024+
 * - Relation IDs: negative numbers encoding component and entity associations
 */
export type EntityId<T = unknown, U = unknown> = number & {
  readonly [__componentTypeMarker]: T;
  readonly [__entityIdTypeTag]: U;
};

export type ComponentId<T = void> = EntityId<T, "component">;
export type EntityRelationId<T = void> = EntityId<T, "entity-relation">;
export type ComponentRelationId<T = void> = EntityId<T, "component-relation">;
export type WildcardRelationId<T = void> = EntityId<T, "wildcard-relation">;
export type RelationId<T = void> = EntityRelationId<T> | ComponentRelationId<T> | WildcardRelationId<T>;

/**
 * Constants for ID ranges
 */
export const INVALID_COMPONENT_ID = 0;
export const COMPONENT_ID_MAX = 1023;
export const ENTITY_ID_START = 1024;

/**
 * Constants for relation ID encoding
 */
export const RELATION_SHIFT = 2 ** 42;
export const WILDCARD_TARGET_ID = 0;

/**
 * Check if a component ID is valid (1-1023)
 */
export function isValidComponentId(componentId: number): boolean {
  return componentId >= 1 && componentId <= COMPONENT_ID_MAX;
}

/**
 * Check if an ID is a component ID
 */
export function isComponentId<T>(id: EntityId<T>): id is ComponentId<T> {
  return id >= 1 && id <= COMPONENT_ID_MAX;
}

/**
 * Check if an ID is an entity ID
 */
export function isEntityId<T>(id: EntityId<T>): id is EntityId<T> {
  return id >= ENTITY_ID_START;
}

/**
 * Check if an ID is a relation ID
 */
export function isRelationId<T>(id: EntityId<T>): id is RelationId<T> {
  return id < 0;
}

/**
 * Create a component ID
 * @param id Component identifier (1-1023)
 * @internal This function is for internal use and testing only. Use `component()` to create components.
 * @see component
 */
export function createComponentId<T = void>(id: number): ComponentId<T> {
  if (id < 1 || id > COMPONENT_ID_MAX) {
    throw new Error(`Component ID must be between 1 and ${COMPONENT_ID_MAX}`);
  }
  return id as ComponentId<T>;
}

/**
 * Create an entity ID
 * @param id Entity identifier (starting from 1024)
 */
export function createEntityId(id: number): EntityId {
  if (id < ENTITY_ID_START) {
    throw new Error(`Entity ID must be ${ENTITY_ID_START} or greater`);
  }
  return id as EntityId;
}
