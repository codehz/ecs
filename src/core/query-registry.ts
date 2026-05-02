import type { QueryFilter } from "../query/filter";
import { Query } from "../query/query";
import type { Archetype } from "./archetype";
import type { EntityId } from "./entity";
import type { World } from "./world";

/**
 * Manages the lifecycle and caching of `Query` instances.
 *
 * Responsibilities:
 * - Create / reuse cached queries keyed by component-type + filter signature.
 * - Track reference counts so queries are only disposed when truly unused.
 * - Notify registered queries when new archetypes are created or destroyed.
 *
 * The `_cacheKey` string that was previously attached directly to `Query` is now
 * kept in a private `WeakMap` so the `Query` class doesn't need to expose it.
 */
export class QueryRegistry {
  /** All live queries that should receive archetype notifications. */
  private readonly queries: Query[] = [];
  /** Cache of reusable queries keyed by a deterministic signature string. */
  private readonly cache = new Map<string, { query: Query; refCount: number }>();
  /** Maps each query to its cache key without polluting the Query public API. */
  private readonly cacheKeys = new WeakMap<Query, string>();

  /**
   * Returns (or creates) a cached query for the given component types and filter.
   * Increments the reference count on cache hits.
   *
   * @param world       The world that owns this registry.
   * @param sortedTypes  Normalized (sorted) component types.
   * @param key          Combined cache key (`types|filter`).
   * @param filter       The raw query filter (used when creating a new Query).
   */
  getOrCreate(world: World, sortedTypes: EntityId<any>[], key: string, filter: QueryFilter): Query {
    const cached = this.cache.get(key);
    if (cached) {
      cached.refCount++;
      return cached.query;
    }

    const query = new Query(world, sortedTypes, filter);
    this.cacheKeys.set(query, key);
    this.cache.set(key, { query, refCount: 1 });
    return query;
  }

  /**
   * Decrements the reference count for the given query.
   * When the count reaches zero the query is fully disposed.
   */
  release(query: Query): void {
    const key = this.cacheKeys.get(query);
    if (!key) return;

    const cached = this.cache.get(key);
    if (!cached || cached.query !== query) return;

    cached.refCount--;
    if (cached.refCount <= 0) {
      this.cache.delete(key);
      this.unregister(query);
      cached.query._disposeInternal();
    }
  }

  /**
   * Registers a query so it receives future archetype notifications.
   * Called automatically by the `Query` constructor via `world._registerQuery`.
   */
  register(query: Query): void {
    this.queries.push(query);
  }

  /**
   * Removes a query from the notification list.
   * Called by `Query._disposeInternal` via `world._unregisterQuery`.
   */
  unregister(query: Query): void {
    const index = this.queries.indexOf(query);
    if (index !== -1) {
      this.queries.splice(index, 1);
    }
  }

  /**
   * Notifies all live queries that a new archetype has been created.
   * Queries will add the archetype to their cache if it matches.
   */
  onNewArchetype(archetype: Archetype): void {
    for (const query of this.queries) {
      query.checkNewArchetype(archetype);
    }
  }

  /**
   * Notifies all live queries that an archetype has been destroyed.
   * Queries will remove the archetype from their internal cache.
   */
  onArchetypeRemoved(archetype: Archetype): void {
    for (const query of this.queries) {
      query.removeArchetype(archetype);
    }
  }
}
