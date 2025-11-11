import { Archetype } from "./archetype";
import type { EntityId } from "./entity";
import { matchesComponentTypes, matchesFilter, type QueryFilter } from "./query-filter";
import type { ComponentTuple, ComponentType } from "./types";
import type { World } from "./world";

/**
 * Query class for efficient entity queries with cached archetypes
 */
export class Query {
  private world: World<any[]>;
  private componentTypes: EntityId<any>[];
  private filter: QueryFilter;
  private cachedArchetypes: Archetype[] = [];
  private isDisposed = false;

  constructor(world: World<any[]>, componentTypes: EntityId<any>[], filter: QueryFilter = {}) {
    this.world = world;
    this.componentTypes = [...componentTypes].sort((a, b) => a - b);
    this.filter = filter;
    this.updateCache();
    // Register with world for archetype updates
    world._registerQuery(this);
  }

  /**
   * Get all entities matching the query
   */
  getEntities(): EntityId[] {
    if (this.isDisposed) {
      throw new Error("Query has been disposed");
    }
    const result: EntityId[] = [];
    for (const archetype of this.cachedArchetypes) {
      result.push(...archetype.getEntities());
    }
    return result;
  }

  /**
   * Get entities with their component data
   * @param componentTypes Array of component types to retrieve
   * @returns Array of objects with entity and component data
   */
  getEntitiesWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }> {
    if (this.isDisposed) {
      throw new Error("Query has been disposed");
    }

    const result: Array<{
      entity: EntityId;
      components: ComponentTuple<T>;
    }> = [];

    for (const archetype of this.cachedArchetypes) {
      const entitiesWithData = archetype.getEntitiesWithComponents(componentTypes);
      result.push(...entitiesWithData);
    }

    return result;
  }

  /**
   * Iterate over entities with their component data
   * @param componentTypes Array of component types to retrieve
   * @param callback Function called for each entity with its components
   */
  forEach<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
  ): void {
    if (this.isDisposed) {
      throw new Error("Query has been disposed");
    }

    for (const archetype of this.cachedArchetypes) {
      archetype.forEachWithComponents(componentTypes, callback);
    }
  }

  /**
   * Get component data arrays for all matching entities
   * @param componentType The component type to retrieve
   * @returns Array of component data for all matching entities
   */
  getComponentData<T>(componentType: EntityId<T>): T[] {
    if (this.isDisposed) {
      throw new Error("Query has been disposed");
    }

    const result: T[] = [];
    for (const archetype of this.cachedArchetypes) {
      result.push(...archetype.getComponentData(componentType));
    }
    return result;
  }

  /**
   * Update the cached archetypes
   * Called when new archetypes are created
   */
  updateCache(): void {
    if (this.isDisposed) return;

    this.cachedArchetypes = this.world
      .getMatchingArchetypes(this.componentTypes)
      .filter((archetype: Archetype) => matchesFilter(archetype, this.filter));
  }

  /**
   * Check if a new archetype matches this query and add to cache if it does
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
   * Remove an archetype from the cached archetypes
   */
  removeArchetype(archetype: Archetype): void {
    if (this.isDisposed) return;
    const index = this.cachedArchetypes.indexOf(archetype);
    if (index !== -1) {
      this.cachedArchetypes.splice(index, 1);
    }
  }

  /**
   * Dispose the query and disconnect from world
   */
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
   * Internal full dispose called by World when refCount reaches zero.
   */
  _disposeInternal(): void {
    if (!this.isDisposed) {
      // Unregister from world (remove from notification list)
      this.world._unregisterQuery(this);
      this.cachedArchetypes = [];
      this.isDisposed = true;
    }
  }

  /**
   * Symbol.dispose implementation for automatic resource management
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Check if the query has been disposed
   */
  get disposed(): boolean {
    return this.isDisposed;
  }
}
