import { MISSING_COMPONENT, type Archetype } from "../archetype/archetype";
import type { EntityId, WildcardRelationId } from "../entity";
import { isSparseRelation, isWildcardRelationId } from "../entity";

/**
 * Write ops required by {@link EntityView}. Implemented by World (command buffer path).
 * Kept minimal so the view does not hard-depend on the World class surface.
 */
export interface EntityViewWriteTarget {
  set(entityId: EntityId, componentType: EntityId<void>): void;
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  remove<T>(entityId: EntityId, componentType: EntityId<T>): void;
  delete(entityId: EntityId): void;
}

/**
 * Entity-scoped view for hot-path query iteration.
 *
 * Bound to a single entity within a matching archetype for the duration of a
 * {@link Query.forEachView} / {@link Query.iterateView} callback (or generator step).
 *
 * **Lifetime**: only valid inside the current callback / generator step. The same
 * instance is rebound across entities; do not store or collect views for later use.
 *
 * Reads resolve components via the bound archetype (plain columns are cached).
 * Writes are pure forwards into the world's command buffer (`set` / `remove` / `delete`)
 * and only take effect after `world.sync()` — same deferred model as calling World directly.
 */
export interface EntityView {
  /** Entity currently bound to this view. */
  readonly entity: EntityId;

  /**
   * Whether the bound entity currently has the given component.
   * Matches {@link World.has} semantics for regular (non-singleton) entities.
   */
  has<T>(componentType: EntityId<T>): boolean;

  /**
   * Read a wildcard relation list for the bound entity.
   * @throws If the entity cannot provide the relation (same rules as {@link World.get}).
   */
  get<T>(componentType: WildcardRelationId<T>): [EntityId<unknown>, any][];
  /**
   * Read component data for the bound entity.
   * @throws If the component is absent — use {@link has} or {@link getOptional}.
   *         `undefined` is a valid stored value and does not mean "missing".
   */
  get<T>(componentType: EntityId<T>): T;

  /**
   * Optional read for a wildcard relation list.
   * Returns `{ value }` when at least one relation exists; otherwise `undefined`.
   */
  getOptional<T>(componentType: WildcardRelationId<T>): { value: [EntityId<unknown>, T][] } | undefined;
  /**
   * Optional read. Returns `{ value }` when present; `undefined` when absent.
   */
  getOptional<T>(componentType: EntityId<T>): { value: T } | undefined;

  /** Queue a void component on the bound entity (command buffer). */
  set(componentType: EntityId<void>): void;
  /** Queue add/update of component data on the bound entity (command buffer). */
  set<T>(componentType: EntityId<T>, component: NoInfer<T>): void;

  /** Queue removal of a component from the bound entity (command buffer). */
  remove<T>(componentType: EntityId<T>): void;

  /** Queue deletion of the bound entity (command buffer). */
  delete(): void;
}

/**
 * @internal Reusable entity-scoped view. Rebound per entity by Query.
 */
export class EntityViewImpl implements EntityView {
  private readonly world: EntityViewWriteTarget;
  private archetype: Archetype | null = null;
  private _entity: EntityId = 0 as EntityId;
  private index = 0;
  /** Column cache for the currently bound archetype (plain components only). */
  private readonly columnCache = new Map<EntityId<any>, any[]>();

  constructor(world: EntityViewWriteTarget) {
    this.world = world;
  }

  get entity(): EntityId {
    return this._entity;
  }

  /** @internal Bind a new archetype; clears column cache. */
  bindArchetype(archetype: Archetype): void {
    this.archetype = archetype;
    this.columnCache.clear();
  }

  /** @internal Bind entity + dense index within the current archetype. */
  bindEntity(entity: EntityId, index: number): void {
    this._entity = entity;
    this.index = index;
  }

  has<T>(componentType: EntityId<T>): boolean {
    const archetype = this.archetype!;
    // Wildcard: presence means ≥1 matching edge (align with World.has / getOptional).
    if (isWildcardRelationId(componentType as EntityId<any>)) {
      const relations = archetype.get(this._entity, componentType as WildcardRelationId<T>);
      return relations.length > 0;
    }
    if (archetype.componentTypeSet.has(componentType)) return true;
    if (isSparseRelation(componentType)) {
      return archetype.getOptional(this._entity, componentType) !== undefined;
    }
    return false;
  }

  get<T>(componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const archetype = this.archetype!;

    if (isWildcardRelationId(componentType as EntityId<any>)) {
      return archetype.get(this._entity, componentType as WildcardRelationId<T>);
    }

    const column = this.getCachedColumn(componentType as EntityId<T>);
    if (column !== undefined) {
      const data = column[this.index];
      if (data === MISSING_COMPONENT) {
        throw new Error(
          `Entity ${this._entity} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
      return data as T;
    }

    // Sparse / not a plain column — fall back to archetype path (still skips world entity→archetype lookup).
    return archetype.get(this._entity, componentType as EntityId<T>);
  }

  getOptional<T>(
    componentType: EntityId<T> | WildcardRelationId<T>,
  ): { value: T } | { value: [EntityId<unknown>, T][] } | undefined {
    const archetype = this.archetype!;

    if (isWildcardRelationId(componentType as EntityId<any>)) {
      const wildcardData = archetype.get(this._entity, componentType as WildcardRelationId<T>) as [
        EntityId<unknown>,
        T,
      ][];
      if (Array.isArray(wildcardData) && wildcardData.length > 0) {
        return { value: wildcardData };
      }
      return undefined;
    }

    const column = this.getCachedColumn(componentType as EntityId<T>);
    if (column !== undefined) {
      const data = column[this.index];
      if (data === MISSING_COMPONENT) return undefined;
      return { value: data as T };
    }

    return archetype.getOptional(this._entity, componentType as EntityId<T>);
  }

  set(componentType: EntityId<any>, component?: any): void {
    if (arguments.length === 1) {
      this.world.set(this._entity, componentType as EntityId<void>);
    } else {
      this.world.set(this._entity, componentType, component);
    }
  }

  remove<T>(componentType: EntityId<T>): void {
    this.world.remove(this._entity, componentType);
  }

  delete(): void {
    this.world.delete(this._entity);
  }

  private getCachedColumn(componentType: EntityId<any>): any[] | undefined {
    let column = this.columnCache.get(componentType);
    if (column !== undefined) return column;

    column = this.archetype!.getOptionalComponentData(componentType);
    if (column !== undefined) {
      this.columnCache.set(componentType, column);
    }
    return column;
  }
}
