import type { Archetype } from "../archetype/archetype";
import { normalizeComponentTypes } from "../component/type-utils";
import type { EntityId, WildcardRelationId } from "../entity";
import { getDetailedIdType, isSparseComponent } from "../entity";
import type { ComponentTuple, ComponentType } from "../types";
import type { World } from "../world/world";
import { matchesComponentTypes, matchesFilter, type QueryFilter } from "./filter";
import type { QueryRegistry } from "./registry";

function isSpecificSparseRelation(type: EntityId<any>): boolean {
  const detailedType = getDetailedIdType(type);
  return (
    (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
    detailedType.componentId !== undefined &&
    isSparseComponent(detailedType.componentId)
  );
}

/**
 * Cached query for efficiently iterating entities with specific components.
 *
 * Queries are created via {@link World.createQuery} and should be **reused across frames**
 * for optimal performance. The world automatically keeps the query's internal archetype cache
 * up to date as entities are created and destroyed.
 *
 * @example
 * const movementQuery = world.createQuery([Position, Velocity]);
 *
 * // In the game loop
 * movementQuery.forEach([Position, Velocity], (entity, pos, vel) => {
 *   pos.x += vel.x;
 *   pos.y += vel.y;
 * });
 */
export class Query {
  private world: World;
  private componentTypes: EntityId<any>[];
  private filter: QueryFilter;
  private cachedArchetypes: Archetype[] = [];
  private isDisposed = false;
  /** Cache key assigned by World for O(1) releaseQuery lookup */
  _cacheKey: string | undefined;
  /** Cached wildcard component types for faster entity filtering */
  private wildcardTypes: WildcardRelationId<any>[];
  /** Cached specific sparse relation types that need entity-level filtering */
  private specificSparseRelationTypes: EntityId<any>[];
  /**
   * Specific sparse relation types listed in `negativeComponentTypes`.
   * These cannot be excluded at the archetype layer (signature only has the wildcard marker).
   */
  private negativeSpecificSparseRelationTypes: EntityId<any>[];
  /** True when iteration must filter entities one-by-one (not just archetypes) */
  private needsEntityFilter: boolean;

  /**
   * @internal Queries should be created via {@link World.createQuery}, not instantiated directly.
   */
  constructor(world: World, componentTypes: EntityId<any>[], filter: QueryFilter = {}, registry?: QueryRegistry) {
    this.world = world;
    this.componentTypes = normalizeComponentTypes(componentTypes);
    this.filter = filter;
    // Pre-compute wildcard types once
    this.wildcardTypes = this.componentTypes.filter(
      (ct) => getDetailedIdType(ct).type === "wildcard-relation",
    ) as WildcardRelationId<any>[];
    // Pre-compute specific sparse relation types that need entity-level filtering
    this.specificSparseRelationTypes = this.componentTypes.filter(isSpecificSparseRelation);
    // Negative specific sparse targets: archetype signature cannot exclude them
    this.negativeSpecificSparseRelationTypes = (filter.negativeComponentTypes ?? []).filter(isSpecificSparseRelation);
    this.needsEntityFilter =
      this.wildcardTypes.length > 0 ||
      this.specificSparseRelationTypes.length > 0 ||
      this.negativeSpecificSparseRelationTypes.length > 0;
    this.updateCache();
    // Register with registry for archetype updates
    if (registry) {
      registry.register(this);
    }
  }

  /**
   * Check if query is disposed and throw error if so
   */
  private ensureNotDisposed(): void {
    if (this.isDisposed) {
      throw new Error("Query has been disposed");
    }
  }

  /**
   * Check if entity matches all query requirements (wildcards, specific sparse relations, negatives)
   */
  private entityMatchesQuery(archetype: Archetype, entity: EntityId): boolean {
    // Check wildcard relations
    for (const wildcardType of this.wildcardTypes) {
      const relations = archetype.get(entity, wildcardType);
      if (!relations || relations.length === 0) {
        return false;
      }
    }

    // Check positive specific sparse relations
    for (const specificType of this.specificSparseRelationTypes) {
      const result = archetype.getOptional(entity, specificType);
      if (result === undefined) {
        return false;
      }
    }

    // Check negative specific sparse relations (entity-level only)
    for (const negativeType of this.negativeSpecificSparseRelationTypes) {
      const result = archetype.getOptional(entity, negativeType);
      if (result !== undefined) {
        return false;
      }
    }

    return true;
  }

  /**
   * Iterate matching entities, applying entity-level filters when needed.
   */
  private forEachMatchingEntity(callback: (archetype: Archetype, entity: EntityId) => void): void {
    if (!this.needsEntityFilter) {
      for (const archetype of this.cachedArchetypes) {
        for (const entity of archetype.getEntities()) {
          callback(archetype, entity);
        }
      }
      return;
    }

    for (const archetype of this.cachedArchetypes) {
      for (const entity of archetype.getEntities()) {
        if (this.entityMatchesQuery(archetype, entity)) {
          callback(archetype, entity);
        }
      }
    }
  }

  /**
   * Returns all entity IDs that match this query.
   *
   * @returns Array of matching entity IDs
   *
   * @example
   * const entities = query.getEntities();
   * for (const entity of entities) {
   *   const pos = world.get(entity, Position);
   * }
   */
  getEntities(): EntityId[] {
    this.ensureNotDisposed();

    const result: EntityId[] = [];
    this.forEachMatchingEntity((_archetype, entity) => {
      result.push(entity);
    });
    return result;
  }

  /**
   * Returns all matching entities along with their component data.
   *
   * @param componentTypes - Array of component types to retrieve
   * @returns Array of objects containing the entity ID and its component tuple
   *
   * @example
   * const results = query.getEntitiesWithComponents([Position, Velocity]);
   * results.forEach(({ entity, components: [pos, vel] }) => {
   *   pos.x += vel.x;
   * });
   */
  getEntitiesWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }> {
    this.ensureNotDisposed();

    const result: Array<{
      entity: EntityId;
      components: ComponentTuple<T>;
    }> = [];

    for (const archetype of this.cachedArchetypes) {
      const filter = this.needsEntityFilter
        ? (entity: EntityId) => this.entityMatchesQuery(archetype, entity)
        : undefined;
      archetype.appendEntitiesWithComponents(componentTypes, result, filter);
    }
    return result;
  }

  /**
   * Iterates over all matching entities and invokes the callback with their component data.
   * This is the preferred way to read and mutate components in a hot loop.
   *
   * @param componentTypes - Array of component types to retrieve
   * @param callback - Function called for each matching entity with its components
   *
   * @example
   * query.forEach([Position, Velocity], (entity, pos, vel) => {
   *   pos.x += vel.x;
   *   pos.y += vel.y;
   * });
   */
  forEach<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
  ): void {
    this.ensureNotDisposed();

    for (const archetype of this.cachedArchetypes) {
      const filter = this.needsEntityFilter
        ? (entity: EntityId) => this.entityMatchesQuery(archetype, entity)
        : undefined;
      archetype.forEachWithComponents(componentTypes, callback, filter);
    }
  }

  /**
   * Generator that yields each matching entity together with its component data.
   *
   * @param componentTypes - Array of component types to retrieve
   * @yields Tuples of `[entityId, ...components]`
   *
   * @example
   * for (const [entity, pos, vel] of query.iterate([Position, Velocity])) {
   *   pos.x += vel.x;
   * }
   */
  *iterate<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): IterableIterator<[EntityId, ...ComponentTuple<T>]> {
    this.ensureNotDisposed();

    for (const archetype of this.cachedArchetypes) {
      const filter = this.needsEntityFilter
        ? (entity: EntityId) => this.entityMatchesQuery(archetype, entity)
        : undefined;
      yield* archetype.iterateWithComponents(componentTypes, filter);
    }
  }

  /**
   * Returns an array containing the data of a single component for every matching entity.
   *
   * @param componentType - The component type to retrieve
   * @returns Array of component data (one entry per matching entity)
   *
   * @example
   * const positions = query.getComponentData(Position);
   */
  getComponentData<T>(componentType: EntityId<T>): T[] {
    this.ensureNotDisposed();

    // Fast path: no entity filter and component is stored as an archetype column
    if (!this.needsEntityFilter && !isSpecificSparseRelation(componentType)) {
      const result: T[] = [];
      for (const archetype of this.cachedArchetypes) {
        for (const data of archetype.getComponentData(componentType)) {
          result.push(data);
        }
      }
      return result;
    }

    // Slow path: match entities first, then read per-entity (handles sparse + filtered sets)
    const result: T[] = [];
    this.forEachMatchingEntity((archetype, entity) => {
      const optional = archetype.getOptional(entity, componentType);
      if (optional !== undefined) {
        result.push(optional.value);
      }
    });
    return result;
  }

  /**
   * @internal Rebuilds the cached archetype list. Called automatically by the world.
   */
  updateCache(): void {
    if (this.isDisposed) return;

    this.cachedArchetypes = this.world
      .getMatchingArchetypes(this.componentTypes)
      .filter((archetype: Archetype) => matchesFilter(archetype, this.filter));
  }

  /**
   * @internal Called by the world when a new archetype is created.
   */
  checkNewArchetype(archetype: Archetype): void {
    if (this.isDisposed) return;
    if (
      matchesComponentTypes(archetype, this.componentTypes) &&
      matchesFilter(archetype, this.filter) &&
      !this.cachedArchetypes.includes(archetype)
    ) {
      this.cachedArchetypes.push(archetype);
    }
  }

  /**
   * @internal Called by the world when an archetype is destroyed.
   */
  removeArchetype(archetype: Archetype): void {
    if (this.isDisposed) return;
    const index = this.cachedArchetypes.indexOf(archetype);
    if (index !== -1) {
      this.cachedArchetypes.splice(index, 1);
    }
  }

  /**
   * Request disposal of this query.
   * This will decrement the world's reference count for the query.
   * The query will only be fully disposed when the ref count reaches zero.
   */
  dispose(): void {
    // Ask the world to release this query (decrement refcount and fully dispose when zero)
    this.world.releaseQuery(this);
  }

  /**
   * @internal Fully disposes the query when the world's refCount reaches zero.
   */
  _disposeInternal(registry?: QueryRegistry): void {
    if (!this.isDisposed) {
      // Unregister from registry (remove from notification list)
      if (registry) {
        registry.unregister(this);
      }
      this.cachedArchetypes = [];
      this.isDisposed = true;
    }
  }

  /**
   * Using-with-disposals support. Calls {@link dispose} automatically.
   *
   * @example
   * using query = world.createQuery([Position]);
   * // query is released automatically when the block exits
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Whether the query has been disposed and can no longer be used.
   */
  get disposed(): boolean {
    return this.isDisposed;
  }
}
