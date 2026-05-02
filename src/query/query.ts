import type { Archetype } from "../core/archetype";
import { normalizeComponentTypes } from "../core/component-type-utils";
import type { EntityId, WildcardRelationId } from "../core/entity";
import { getDetailedIdType, isDontFragmentComponent } from "../core/entity";
import type { QueryRegistry } from "../core/query-registry";
import type { ComponentTuple, ComponentType } from "../core/types";
import type { World } from "../core/world";
import { matchesComponentTypes, matchesFilter, type QueryFilter } from "./filter";

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
  /** Cached specific dontFragment relation types that need entity-level filtering */
  private specificDontFragmentTypes: EntityId<any>[];

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
    // Pre-compute specific dontFragment relation types that need entity-level filtering
    this.specificDontFragmentTypes = this.componentTypes.filter((ct) => {
      const detailedType = getDetailedIdType(ct);
      return (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        detailedType.componentId !== undefined &&
        isDontFragmentComponent(detailedType.componentId)
      );
    });
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

    // Fast path: no wildcard relations and no specific dontFragment relations
    if (this.wildcardTypes.length === 0 && this.specificDontFragmentTypes.length === 0) {
      const result: EntityId[] = [];
      for (const archetype of this.cachedArchetypes) {
        for (const entity of archetype.getEntities()) {
          result.push(entity);
        }
      }
      return result;
    }

    // Slow path: need to filter entities that actually have the required relations
    // This is necessary for:
    // 1. Wildcard relations where an archetype can contain entities with/without the relation
    // 2. Specific dontFragment relations where the archetype only has the wildcard marker
    const result: EntityId[] = [];
    for (const archetype of this.cachedArchetypes) {
      for (const entity of archetype.getEntities()) {
        if (this.entityMatchesQuery(archetype, entity)) {
          result.push(entity);
        }
      }
    }
    return result;
  }

  /**
   * Check if entity matches all query requirements (wildcards and specific dontFragment relations)
   */
  private entityMatchesQuery(archetype: Archetype, entity: EntityId): boolean {
    // Check wildcard relations
    for (const wildcardType of this.wildcardTypes) {
      const relations = archetype.get(entity, wildcardType);
      if (!relations || relations.length === 0) {
        return false;
      }
    }

    // Check specific dontFragment relations
    for (const specificType of this.specificDontFragmentTypes) {
      const result = archetype.getOptional(entity, specificType);
      if (result === undefined) {
        return false;
      }
    }

    return true;
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
      archetype.appendEntitiesWithComponents(componentTypes, result);
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
      archetype.forEachWithComponents(componentTypes, callback);
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
      yield* archetype.iterateWithComponents(componentTypes);
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

    const result: T[] = [];
    for (const archetype of this.cachedArchetypes) {
      for (const data of archetype.getComponentData(componentType)) {
        result.push(data);
      }
    }
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
