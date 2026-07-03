import type { Archetype } from "../archetype/archetype";
import { SparseStoreImpl } from "../archetype/store";
import { CommandBuffer } from "../commands/buffer";
import { ComponentEntityStore } from "../component/entity-store";
import { normalizeComponentTypes } from "../component/type-utils";
import type { ComponentId, EntityId, WildcardRelationId } from "../entity";
import {
  EntityIdManager,
  RELATION_SHIFT,
  getComponentIdFromRelationId,
  isCascadeDeleteRelation,
  isSparseRelation,
  isWildcardRelationId,
  relation,
} from "../entity";
import { serializeQueryFilter, type QueryFilter } from "../query/filter";
import type { Query } from "../query/query";
import { QueryRegistry } from "../query/registry";
import type { SerializedWorld } from "../storage/serialization";
import type {
  ComponentTuple,
  ComponentType,
  DebugStatsCollector,
  LifecycleCallback,
  LifecycleHook,
  LifecycleHookEntry,
  SyncDebugStats,
} from "../types";
import { isOptionalEntityId } from "../types";
import { ArchetypeManager } from "./archetype-manager";
import { EntityBuilder } from "./builder";
import { CommandExecutor, type CommandExecutorContext } from "./command-executor";
import { DebugStatsManager } from "./debug-stats";
import {
  collectMultiHookComponents,
  triggerLifecycleHooks,
  triggerRemoveHooksForEntityDeletion,
  type HooksContext,
} from "./hooks";
import {
  assertEntityExists,
  assertSetComponentTypeValid,
  resolveRemoveOperation,
  resolveSetOperation,
} from "./operations";
import { getEntityReferences, type EntityReferencesMap } from "./references";
import { deserializeWorld, serializeWorld } from "./serialization";
import { SingletonHandle } from "./singleton";

/**
 * World class for ECS architecture
 * Manages entities and components
 */
export class World {
  private static readonly DEPRECATED_SINGLETON_SET_SHORTHAND_WARNING =
    "world.set(componentId, value) for singleton components is deprecated; use world.singleton(componentId).set(value) or world.set(componentId, componentId, value) instead.";

  // Core data structures for entity and archetype management
  private entityIdManager = new EntityIdManager();
  private entityReferences: EntityReferencesMap = new Map();
  /** Sparse relation storage (for components created with `sparse: true`), shared with all Archetype instances */
  private readonly sparseStore = new SparseStoreImpl();
  /** Component entity (singleton) storage */
  private readonly componentEntities = new ComponentEntityStore();

  // Archetype storage, indexes, creation/removal, and referencing are now encapsulated
  // in ArchetypeManager (extracted to reduce World line count and improve cohesion).
  private archetypeManager!: ArchetypeManager;

  // Temporary forwarding accessors so the rest of World (and its internal collaborators)
  // can continue using the familiar names with almost zero call-site changes.
  // These can be removed in a follow-up cleanup pass if desired.
  private get archetypes() {
    return this.archetypeManager.archetypes;
  }
  private get entityToArchetype() {
    return this.archetypeManager.entityToArchetype;
  }
  private get archetypesByComponent() {
    return this.archetypeManager.archetypesByComponent;
  }
  private get entityToReferencingArchetypes() {
    return this.archetypeManager.entityToReferencingArchetypes;
  }

  // Query registry – manages caching, ref counts, and archetype notifications
  private readonly queryRegistry = new QueryRegistry();

  // Lifecycle hooks (declared before cached contexts that reference them)
  private hooks: Set<LifecycleHookEntry> = new Set();

  // Debug observability (extracted to DebugStatsManager to reduce World line count)
  private readonly debugStats = new DebugStatsManager();

  // Command execution (orchestration extracted to CommandExecutor)
  private commandBuffer!: CommandBuffer;
  private commandExecutor!: CommandExecutor;

  constructor(snapshot?: SerializedWorld) {
    // Must create the manager before any code that may invoke ensureArchetype
    // (including the snapshot deserialization path below, and the closures
    // captured in the field-initialized _commandCtx).
    this.archetypeManager = new ArchetypeManager(
      {
        queryRegistry: this.queryRegistry,
        hooks: this.hooks,
        recordArchetypeCreated: () => this.debugStats.recordArchetypeCreated(),
        recordArchetypeRemoved: () => this.debugStats.recordArchetypeRemoved(),
      },
      this.sparseStore,
    );

    if (snapshot && typeof snapshot === "object") {
      deserializeWorld(
        {
          entityIdManager: this.entityIdManager,
          componentEntities: this.componentEntities,
          entityReferences: this.entityReferences,
          ensureArchetype: (ct) => this.ensureArchetype(ct),
          setEntityToArchetype: (eid, arch) => this.archetypeManager.entityToArchetype.set(eid, arch),
        },
        snapshot,
      );
    }

    // CommandExecutor must be created after archetypeManager (and debugStats) because its context
    // closes over several pieces and the destroy fast path.
    const execCtx: CommandExecutorContext = {
      componentEntities: this.componentEntities,
      entityReferences: this.entityReferences,
      hooks: this.hooks,
      entityToArchetype: this.entityToArchetype,
      ensureArchetype: (ct) => this.ensureArchetype(ct),
      sparseStore: this.sparseStore,
      has: (eid, ct) => this.has(eid, ct),
      get: (eid, ct) => this.get(eid, ct),
      getOptional: (eid, ct) => this.getOptional(eid, ct),
      destroyEntityImmediate: (eid) => this.destroyEntityImmediate(eid),
      incrementMigrations: () => this.debugStats.incrementMigrations(),
      triggerLifecycleHooks,
      triggerRemoveHooksForEntityDeletion,
    };
    this.commandExecutor = new CommandExecutor(execCtx);

    this.commandBuffer = new CommandBuffer((entityId, commands) =>
      this.commandExecutor.executeEntityCommands(entityId, commands),
    );
  }

  /**
   * Creates a new entity.
   * The entity is created with an empty component set and can be configured using `set()`.
   *
   * @template T - The initial component type (defaults to void if not specified)
   * @returns A unique identifier for the new entity
   *
   * @example
   * const entity = world.new<MyComponent>();
   * world.set(entity, MyComponent, { value: 42 });
   * world.sync();
   */
  new<T = void>(): EntityId<T> {
    const entityId = this.entityIdManager.allocate();
    let emptyArchetype = this.ensureArchetype([]);
    emptyArchetype.addEntity(entityId, new Map());
    this.entityToArchetype.set(entityId, emptyArchetype);
    return entityId as EntityId<T>;
  }

  /**
   * Semantic alias for `new()` to avoid confusion with the `new` keyword.
   * Creates a new entity with an empty component set.
   *
   * @example
   * const entity = world.create<MyComponent>();
   */
  create<T = void>(): EntityId<T> {
    return this.new<T>();
  }

  /** Fast path: destroy an entity that is not referenced by any other entity, skipping BFS */
  private destroySingleEntity(entityId: EntityId): void {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) return;

    // Handle entity references (this entity references other entities)
    for (const [sourceEntityId, componentType] of getEntityReferences(this.entityReferences, entityId)) {
      if (this.entityToArchetype.has(sourceEntityId)) {
        this.removeComponentImmediate(sourceEntityId, componentType, entityId);
      }
    }

    this.entityReferences.delete(entityId);
    const removedComponents = archetype.removeEntity(entityId)!;
    this.entityToArchetype.delete(entityId);

    triggerRemoveHooksForEntityDeletion(entityId, removedComponents, archetype);

    this.cleanupArchetypesReferencingEntity(entityId);
    this.entityIdManager.deallocate(entityId);
    this.componentEntities.cleanupReferencesTo(entityId);
  }

  private destroyEntityImmediate(entityId: EntityId): void {
    // Fast path: no other entity references this one, delete directly
    if (!this.entityReferences.has(entityId)) {
      this.destroySingleEntity(entityId);
      return;
    }

    const queue: EntityId[] = [entityId];
    const visited = new Set<EntityId>();
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const cur = queue[queueIndex++]!;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const archetype = this.entityToArchetype.get(cur);
      if (!archetype) continue;

      // Process entity references before removal
      for (const [sourceEntityId, componentType] of getEntityReferences(this.entityReferences, cur)) {
        if (!this.entityToArchetype.has(sourceEntityId)) continue;

        if (isCascadeDeleteRelation(componentType)) {
          if (!visited.has(sourceEntityId)) {
            queue.push(sourceEntityId);
          }
        } else {
          this.removeComponentImmediate(sourceEntityId, componentType, cur);
        }
      }

      // Remove entity from archetype - this also cleans up sparse relations
      // and returns all removed component data
      this.entityReferences.delete(cur);
      const removedComponents = archetype.removeEntity(cur)!;
      this.entityToArchetype.delete(cur);

      // Trigger lifecycle hooks for removed components (fast path for entity deletion)
      triggerRemoveHooksForEntityDeletion(cur, removedComponents, archetype);

      this.cleanupArchetypesReferencingEntity(cur);
      this.entityIdManager.deallocate(cur);
      this.componentEntities.cleanupReferencesTo(cur);
    }
  }

  /**
   * Checks if an **entity** (not a component) exists in the world.
   *
   * This is specifically for checking entity liveness — whether the given entity ID
   * is currently alive in the world. For checking if a component is present on an
   * entity, use {@link has} instead.
   *
   * @param entityId - The entity identifier to check
   * @returns `true` if the entity exists, `false` otherwise
   *
   * @example
   * // Check if an entity is alive
   * if (world.exists(entityId)) {
   *   console.log("Entity exists");
   * }
   *
   * // To check for a component, use has() instead:
   * if (world.has(entity, Position)) { ... }
   */
  exists(entityId: EntityId): boolean {
    if (this.componentEntities.exists(entityId)) return true;
    return this.entityToArchetype.has(entityId);
  }

  /**
   * Marks a void component as present on an entity.
   * The change is buffered and takes effect after calling `world.sync()`.
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component type is invalid or is a wildcard relation
   *
   * @example
   * world.set(entity, Marker);
   * world.sync();
   */
  set(entityId: EntityId, componentType: EntityId<void>): void;
  /**
   * @deprecated Use `world.singleton(componentId).set(value)` or `world.set(componentId, componentId, value)` instead.
   * Compatibility shorthand for singleton component data when the second argument is not a number.
   *
   * @throws {Error} If the component entity does not exist
   *
   * @example
   * world.set(GlobalConfig, { debug: true });
   * world.sync();
   */
  set<T>(componentId: ComponentId<T>, component: Exclude<NoInfer<T>, number>): void;
  /**
   * Adds or updates component data on an entity.
   * The change is buffered and takes effect after calling `world.sync()`.
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component type is invalid or is a wildcard relation
   *
   * @example
   * world.set(entity, Position, { x: 10, y: 20 });
   * world.sync();
   */
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  /** Internal implementation for `set()` overloads. */
  set(entityId: EntityId | ComponentId, componentTypeOrComponent?: EntityId | any, maybeComponent?: any): void {
    const {
      entityId: targetEntityId,
      componentType,
      component,
      deprecatedSingletonShorthand,
    } = resolveSetOperation(entityId, componentTypeOrComponent, maybeComponent, arguments.length, (id) =>
      this.exists(id),
    );
    if (deprecatedSingletonShorthand) {
      console.warn(World.DEPRECATED_SINGLETON_SET_SHORTHAND_WARNING);
    }
    this.commandBuffer.set(targetEntityId, componentType, component);
  }

  /**
   * Removes a component from an entity.
   * The change is buffered and takes effect after calling `world.sync()`.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The component type to remove
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component type is invalid
   *
   * @example
   * world.remove(entity, Position);
   * world.sync(); // Apply changes
   */
  remove<T>(entityId: EntityId, componentType: EntityId<T>): void;
  /**
   * Removes a singleton component (shorthand for remove(componentId, componentId)).
   * The change is buffered and takes effect after calling `world.sync()`.
   *
   * @template T - The component data type
   *
   * @throws {Error} If the component entity does not exist
   *
   * @example
   * world.remove(GlobalConfig); // Remove singleton component
   * world.sync(); // Apply changes
   */
  remove<T>(componentId: ComponentId<T>): void;
  remove<T>(entityId: EntityId | ComponentId, componentType?: EntityId<T>): void {
    const { entityId: targetEntityId, componentType: targetComponentType } = resolveRemoveOperation(
      entityId,
      componentType,
      (id) => this.exists(id),
    );
    this.commandBuffer.remove(targetEntityId, targetComponentType);
  }

  /**
   * Deletes an entity and all its components from the world.
   * The change is buffered and takes effect after calling `world.sync()`.
   * Related entities may trigger cascade delete hooks if configured.
   *
   * @param entityId - The entity identifier to delete
   *
   * @example
   * world.delete(entity);
   * world.sync(); // Apply changes
   */
  delete(entityId: EntityId): void {
    this.commandBuffer.delete(entityId);
  }

  /**
   * Returns an explicit handle for a singleton component (component-as-entity).
   *
   * This is the preferred API for singleton components.
   *
   * @example
   * const config = world.singleton(GlobalConfig);
   * config.set({ debug: true });
   * world.sync();
   * console.log(config.get());
   */
  singleton<T>(componentId: ComponentId<T>): SingletonHandle<T> {
    assertEntityExists(componentId, "Component entity", (id) => this.exists(id));
    assertSetComponentTypeValid(componentId);

    return new SingletonHandle(componentId, {
      has: () => this.componentEntities.hasSingleton(componentId),
      get: () => this.get(componentId),
      getOptional: () => this.getOptional(componentId),
      remove: () => this.commandBuffer.remove(componentId, componentId),
      set: (value) => {
        this.commandBuffer.set(componentId, componentId as EntityId<any>, value as any);
      },
    });
  }

  /**
   * Checks if a specific **component** is present on an entity.
   *
   * This is for component membership checks — does the given entity have this
   * component type? For checking whether an entity itself is alive, use
   * {@link exists} instead.
   *
   * Immediately reflects the current state without waiting for `sync()`.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The component type to check
   * @returns `true` if the entity has the component, `false` otherwise
   *
   * @example
   * // Check if an entity has a component
   * if (world.has(entity, Position)) {
   *   const pos = world.get(entity, Position);
   * }
   */
  has<T>(entityId: EntityId, componentType: EntityId<T>): boolean;
  /**
   * Checks if a **singleton component** (component-as-entity) is present.
   * Equivalent to `has(componentId, componentId)`.
   *
   * Immediately reflects the current state without waiting for `sync()`.
   *
   * @template T - The component data type
   * @param componentId - The singleton component ID
   * @returns `true` if the singleton component exists, `false` otherwise
   *
   * @example
   * if (world.has(GlobalConfig)) {
   *   const config = world.get(GlobalConfig);
   * }
   */
  has<T>(componentId: ComponentId<T>): boolean;
  has<T>(entityId: EntityId | ComponentId, componentType?: EntityId<T>): boolean {
    // Handle singleton component overload: has(componentId)
    if (componentType === undefined) {
      const componentId = entityId as ComponentId<T>;
      return this.componentEntities.hasSingleton(componentId);
    }

    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId === undefined) return false;
        return this.componentEntities.hasWildcard(entityId, componentId);
      }
      return this.componentEntities.has(entityId, componentType);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) return false;

    if (archetype.componentTypeSet.has(componentType)) return true;

    if (isSparseRelation(componentType)) {
      // Use getValue; presence check via getAllForEntity only if value can legitimately be undefined
      const val = this.sparseStore.getValue(entityId, componentType);
      if (val !== undefined) return true;
      return this.sparseStore.getAllForEntity(entityId).some(([t]) => t === componentType);
    }

    return false;
  }

  /**
   * Retrieves a component from an entity.
   * Throws an error if the component does not exist; use `has()` to check first or use `getOptional()`.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The component type to retrieve
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component does not exist on the entity
   *
   * @example
   * const position = world.get(entity, Position);
   */
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  /**
   * Retrieves all relations of a given wildcard type for an entity.
   * Returns an array of [target entity, component value] pairs.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The wildcard relation type
   * @returns Array of [target entity, component value] pairs
   *
   * @throws {Error} If the entity does not exist
   *
   * @example
   * const relations = world.get(entity, relation(Parent, "*"));
   */
  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][];
  /**
   * Retrieves the entity's primary component when called with only an entity ID.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @returns The component value
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component does not exist on the entity
   */
  get<T>(entityId: EntityId<T>): T;
  get<T>(
    entityId: EntityId,
    componentType: EntityId<T> | WildcardRelationId<T> = entityId as EntityId<T>,
  ): T | [EntityId<unknown>, any][] {
    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType as EntityId<any>)) {
        return this.componentEntities.getWildcard(entityId, componentType as WildcardRelationId<T>);
      }
      return this.componentEntities.get(entityId, componentType as EntityId<T>);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (componentType >= 0 || componentType % RELATION_SHIFT !== 0) {
      const inArchetype = archetype.componentTypeSet.has(componentType);
      const hasSparse = isSparseRelation(componentType);
      const hasComponent =
        inArchetype ||
        (hasSparse &&
          (this.sparseStore.getValue(entityId, componentType) !== undefined ||
            this.sparseStore.getAllForEntity(entityId).some(([t]) => t === componentType)));

      if (!hasComponent) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
    }

    return archetype.get(entityId, componentType) as T | [EntityId<unknown>, any][];
  }

  /**
   * Safely retrieves a component from an entity without throwing an error.
   * Returns `undefined` if the component does not exist.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The component type to retrieve
   * @returns The component value wrapped in `{ value }`, or `undefined` if absent
   *
   * @throws {Error} If the entity does not exist
   *
   * @example
   * const position = world.getOptional(entity, Position);
   * if (position) {
   *   console.log(position.value.x);
   * }
   */
  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined;
  /**
   * Safely retrieves all matching relation values for a wildcard relation type.
   * Returns `undefined` if there are no relations.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The wildcard relation type
   * @returns Array of [target, value] pairs wrapped in `{ value }`, or `undefined` if none
   *
   * @throws {Error} If the entity does not exist
   */
  getOptional<T>(
    entityId: EntityId,
    componentType: WildcardRelationId<T>,
  ): { value: [EntityId<unknown>, T][] } | undefined;
  /**
   * Safely retrieves the entity's primary component without throwing an error.
   * Returns `undefined` if the component does not exist.
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @returns The component value wrapped in `{ value }`, or `undefined` if absent
   *
   * @throws {Error} If the entity does not exist
   */
  getOptional<T>(entityId: EntityId<T>): { value: T } | undefined;
  getOptional<T>(
    entityId: EntityId,
    componentType: EntityId<T> | WildcardRelationId<T> = entityId as EntityId<T>,
  ): { value: T } | { value: [EntityId<unknown>, T][] } | undefined {
    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const relations = this.componentEntities.getWildcard(entityId, componentType);
        if (relations.length === 0) return undefined;
        return { value: relations };
      }
      return this.componentEntities.getOptional(entityId, componentType);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (isWildcardRelationId(componentType)) {
      // For wildcard relations, get the data and wrap in optional if non-empty
      const wildcardData = archetype.get(entityId, componentType) as [EntityId<unknown>, T][];
      if (Array.isArray(wildcardData) && wildcardData.length > 0) {
        return { value: wildcardData };
      }
      return undefined;
    }

    return archetype.getOptional(entityId, componentType);
  }

  // ==========================================================================
  // Relation & Hierarchy Companion Tools (public API)
  // ==========================================================================

  /**
   * Retrieves all targets (and their associated data) for relations of a given
   * base component on an entity.
   *
   * This is the ergonomic replacement for the common pattern:
   *   world.get(entity, relation(Comp, "*"))
   *
   * @example
   * const ChildOf = component({ exclusive: true, sparse: true });
   * const children = world.getRelationTargets(parent, ChildOf); // usually []
   * const items = world.getRelationTargets(player, InInventory);
   *
   * // For common hierarchy use cases, prefer the higher-level helpers:
   * // world.getChildren(parent, ChildOf), world.getParent(child, ChildOf)
   */
  getRelationTargets<T = void>(
    entityId: EntityId,
    relationComp: ComponentId<T>,
  ): [target: EntityId<unknown>, data: T | undefined][] {
    assertEntityExists(entityId, "Entity", (id) => this.exists(id));

    const wildcard = relation(relationComp, "*") as WildcardRelationId<T>;

    // For component entities (singletons) the path is different; they rarely host relations
    if (this.componentEntities.exists(entityId)) {
      return this.componentEntities.getWildcard(entityId, wildcard);
    }

    // Regular entity path — archetype.get for wildcard always materializes the array
    // (even if empty for a sparse relation that only has the marker)
    const data = this.get(entityId, wildcard);
    return data as [EntityId<unknown>, T | undefined][];
  }

  /**
   * Returns every entity that currently holds a relation of the given base
   * component pointing at `targetId`.
   *
   * This is the efficient **reverse** lookup. For common hierarchy cases,
   * prefer the higher-level `world.getChildren(parent, ChildOf)` instead.
   *
   * @example
   * const ChildOf = component({ exclusive: true, sparse: true });
   * const directChildren = world.getRelationSources(ship, ChildOf);
   */
  getRelationSources(targetId: EntityId, relationComp: ComponentId<any>): EntityId[] {
    const refs = getEntityReferences(this.entityReferences, targetId);
    const result: EntityId[] = [];

    for (const [source, relType] of refs) {
      // Only consider still-living sources
      if (!this.entityToArchetype.has(source) && !this.componentEntities.exists(source)) continue;

      const decodedComp = getComponentIdFromRelationId(relType);
      if (decodedComp === relationComp) {
        result.push(source);
      }
    }
    return result;
  }

  /**
   * Returns true if the entity has any (or a specific-target) relation of the
   * given base component.
   */
  hasRelation(entityId: EntityId, relationComp: ComponentId<any>, targetId?: EntityId): boolean {
    assertEntityExists(entityId, "Entity", (id) => this.exists(id));

    if (targetId !== undefined) {
      const specific = relation(relationComp, targetId);
      return this.has(entityId, specific);
    }

    // Any target of this relation kind?
    const targets = this.getRelationTargets(entityId, relationComp);
    return targets.length > 0;
  }

  /**
   * Returns the number of relations of the given base component held by the entity.
   */
  countRelations(entityId: EntityId, relationComp: ComponentId<any>): number {
    assertEntityExists(entityId, "Entity", (id) => this.exists(id));
    const targets = this.getRelationTargets(entityId, relationComp);
    return targets.length;
  }

  /**
   * For an *exclusive* relation (e.g. ChildOf, Owner), returns the single
   * target entity (or undefined if none).
   *
   * When the component was declared `exclusive: true`, this is the preferred
   * accessor (clearer intent than array destructuring).
   */
  getSingleRelationTarget<T = void>(entityId: EntityId, relationComp: ComponentId<T>): EntityId | undefined {
    const targets = this.getRelationTargets(entityId, relationComp);
    return targets.length > 0 ? (targets[0]![0] as EntityId) : undefined;
  }

  // --------------------------------------------------------------------------
  // High-level hierarchy helpers (convenience methods on World)
  // --------------------------------------------------------------------------

  /**
   * Returns the direct children of `parent` for the given relationship component
   * (typically a `ChildOf` or similar exclusive `sparse` relation).
   *
   * This is the recommended high-level API for hierarchy traversal.
   * It uses the internal reverse reference index for efficiency.
   *
   * @example
   * const ChildOf = component({ exclusive: true, sparse: true });
   * const kids = world.getChildren(ship, ChildOf);
   */
  getChildren(parent: EntityId, childOf: ComponentId<any>): EntityId[] {
    return this.getRelationSources(parent, childOf);
  }

  /**
   * Returns the parent of `child` for the given relationship component
   * (typically an exclusive `ChildOf` relation).
   *
   * @example
   * const ChildOf = component({ exclusive: true, sparse: true });
   * const parent = world.getParent(turret, ChildOf);
   */
  getParent(child: EntityId, childOf: ComponentId<any>): EntityId | undefined {
    return this.getSingleRelationTarget(child, childOf);
  }

  /**
   * Returns the ancestor chain from the immediate parent up to (but not
   * including) the root for the given relationship component.
   *
   * @example
   * const ChildOf = component({ exclusive: true, sparse: true });
   * const ancestors = world.getAncestors(muzzle, ChildOf); // [turret, ship]
   */
  getAncestors(entity: EntityId, childOf: ComponentId<any>): EntityId[] {
    const ancestors: EntityId[] = [];
    let cur = this.getParent(entity, childOf);
    while (cur !== undefined) {
      ancestors.push(cur);
      cur = this.getParent(cur, childOf);
    }
    return ancestors;
  }

  /**
   * Iteratively traverses all descendants of `root` in DFS pre-order.
   * This is a generator and is safe for very deep hierarchies.
   *
   * @example
   * for (const { entity, depth, parent } of world.iterateDescendants(root, ChildOf)) {
   *   console.log(depth, entity);
   * }
   */
  *iterateDescendants(
    root: EntityId,
    childOf: ComponentId<any>,
    opts: { includeSelf?: boolean; maxDepth?: number } = {},
  ): IterableIterator<{ entity: EntityId; depth: number; parent: EntityId | null }> {
    const { includeSelf = false, maxDepth } = opts;
    const stack: Array<{ entity: EntityId; depth: number; parent: EntityId | null }> = [];

    if (includeSelf) {
      stack.push({ entity: root, depth: 0, parent: null });
    } else {
      for (const child of this.getChildren(root, childOf)) {
        stack.push({ entity: child, depth: 1, parent: root });
      }
    }

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (maxDepth !== undefined && current.depth > maxDepth) continue;

      yield current;

      const kids = this.getChildren(current.entity, childOf);
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i]!;
        stack.push({ entity: k, depth: current.depth + 1, parent: current.entity });
      }
    }
  }

  /**
   * Callback-based descendant traversal (hot path friendly).
   * Return `false` from the visitor to stop early.
   */
  traverseDescendants(
    root: EntityId,
    childOf: ComponentId<any>,
    visitor: (entity: EntityId, depth: number, parent: EntityId | null) => void | boolean,
    opts: { includeSelf?: boolean; maxDepth?: number } = {},
  ): void {
    for (const { entity, depth, parent } of this.iterateDescendants(root, childOf, opts)) {
      const res = visitor(entity, depth, parent);
      if (res === false) return;
    }
  }

  /**
   * Registers a lifecycle hook that responds to component changes.
   * The hook callback is invoked when components matching the specified types
   * are added, updated, or removed.
   *
   * @param componentTypes - Component types that define the matching entity set
   * @param hook - Either a hook object with on_init/on_set/on_remove handlers, or a callback function
   * @param filter - Optional query-style filter applied to the hook match set
   * @returns A function that unsubscribes the hook when called
   *
   * @throws {Error} If no required components are specified
   *
   * @example
   * const unsubscribe = world.hook([Position, Velocity], {
   *   on_init: (entityId, position, velocity) => console.log("Initialized"),
   *   on_set: (entityId, position, velocity) => console.log("Updated"),
   *   on_remove: (entityId, position, velocity) => console.log("Removed"),
   * });
   * unsubscribe(); // Remove hook
   *
   * // Callback style
   * const unsubscribe = world.hook([Position], (event, entityId, position) => {
   *   if (event === "init") console.log("Initialized");
   * });
   *
   * // With filter
   * const unsubscribe2 = world.hook(
   *   [Position, Velocity],
   *   {
   *     on_set: (entityId, position, velocity) => console.log(entityId, position, velocity),
   *   },
   *   { negativeComponentTypes: [Disabled] },
   * );
   */
  hook<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    hook: LifecycleHook<T> | LifecycleCallback<T>,
    filter?: QueryFilter,
  ): () => void;
  hook(
    componentTypes: readonly ComponentType<any>[],
    hook: LifecycleHook<any> | LifecycleCallback<any>,
    filter?: QueryFilter,
  ): () => void {
    const isCallback = typeof hook === "function";
    const callback = isCallback ? (hook as LifecycleCallback<any>) : undefined;

    const requiredComponents: EntityId<any>[] = [];
    const optionalComponents: EntityId<any>[] = [];
    for (const ct of componentTypes) {
      if (!isOptionalEntityId(ct)) {
        requiredComponents.push(ct as EntityId<any>);
      } else {
        optionalComponents.push(ct.optional);
      }
    }

    if (requiredComponents.length === 0) {
      throw new Error("Hook must have at least one required component");
    }

    const entry: LifecycleHookEntry = {
      componentTypes,
      requiredComponents,
      optionalComponents,
      filter: filter || {},
      hook: isCallback ? ({} as LifecycleHook<any>) : (hook as LifecycleHook<any>),
      callback,
      matchedArchetypes: new Set(),
    };
    this.hooks.add(entry);

    // Single pass: collect matching archetypes
    const matchedArchetypes: Archetype[] = [];
    for (const archetype of this.archetypes) {
      if (this.archetypeMatchesHook(archetype, entry)) {
        archetype.matchingMultiHooks.add(entry);
        entry.matchedArchetypes!.add(archetype);
        matchedArchetypes.push(archetype);
      }
    }

    // Callback style: invoke callback("init", ...); hook style: invoke hook.on_init(...)
    const shouldFireInit = isCallback || (hook as LifecycleHook<any>).on_init !== undefined;
    if (shouldFireInit) {
      for (const archetype of matchedArchetypes) {
        for (const entityId of archetype.getEntities()) {
          const components = collectMultiHookComponents(this.createHooksContext(), entityId, componentTypes);
          if (isCallback) {
            (callback as LifecycleCallback<any>)("init", entityId, ...components);
          } else {
            (hook as LifecycleHook<any>).on_init!(entityId, ...components);
          }
        }
      }
    }

    return () => {
      this.hooks.delete(entry);
      if (entry.matchedArchetypes) {
        for (const archetype of entry.matchedArchetypes) {
          archetype.matchingMultiHooks.delete(entry);
        }
      }
    };
  }

  /**
   * Creates a debug stats collector that will receive a `SyncDebugStats` payload
   * after every subsequent `sync()`.
   *
   * The returned object is a pure lifecycle handle. It does not store data.
   * Collection stops when you call `[Symbol.dispose]()` (or use a `using` declaration).
   *
   * All active collectors receive the exact same stats object for a given sync.
   * Exceptions thrown by callbacks are ignored.
   *
   * This is intended for development/debugging and leak detection.
   */
  createDebugStatsCollector(callback: (stats: SyncDebugStats) => void): DebugStatsCollector {
    return this.debugStats.createCollector(callback);
  }

  /**
   * Synchronizes all buffered commands (set/remove/delete) to the world.
   * This method must be called after making changes via `set()`, `remove()`, or `delete()` for them to take effect.
   * Typically called once per frame at the end of your game loop.
   *
   * @example
   * world.set(entity, Position, { x: 10, y: 20 });
   * world.remove(entity, OldComponent);
   * world.sync(); // Apply all buffered changes
   */
  sync(): void {
    if (!this.debugStats.hasActiveCollectors()) {
      // Fast path: no debug collectors, skip all timing and stats work
      this.commandBuffer.execute();
      return;
    }

    // Slow path: full instrumentation for active debug stats collectors
    const syncStart = performance.now();
    this.debugStats.resetActivity();

    const commandBufferStart = performance.now();
    const commandIterations = this.commandBuffer.execute();
    const commandBufferEnd = performance.now();

    const syncEnd = performance.now();

    // Build the data bag for the extracted manager (keeps it decoupled from internal maps)
    const entityCount = this.entityToArchetype.size;
    let emptyArchetypes = 0;
    for (const arch of this.archetypes) {
      if (arch.size === 0) emptyArchetypes++;
    }

    let archetypesByComponentSize = 0;
    for (const set of this.archetypesByComponent.values()) {
      archetypesByComponentSize += set.size;
    }

    this.debugStats.deliver(
      {
        syncStart,
        syncEnd,
        commandBufferStart,
        commandBufferEnd,
        commandIterations,
      },
      {
        entityCount,
        freelistSize: this.entityIdManager.getFreelistSize(),
        nextId: this.entityIdManager.getNextId(),
        archetypeCount: this.archetypes.length,
        emptyArchetypes,
        archetypesByComponentSize,
        cachedQueryCount: (this.queryRegistry as any).cache?.size ?? 0,
        registeredQueryCount: (this.queryRegistry as any).queries?.size ?? 0,
        hookCount: this.hooks.size,
        entityReferencesSize: this.entityReferences.size,
        entityToReferencingArchetypesSize: this.entityToReferencingArchetypes.size,
      },
    );
  }

  /**
   * Creates a cached query for efficiently iterating entities with specific components.
   * The query is cached internally and reused across calls with the same component types and filter.
   *
   * **Important:** Store the query reference and reuse it across frames for optimal performance.
   * Creating a new query each frame defeats the caching mechanism.
   *
   * **Note on optional components:** Only **required** (non-optional) component types should be
   * passed to `createQuery`. Optional components (wrapped with `{ optional: ... }`) must be
   * specified at **iteration time** via {@link Query.forEach}, {@link Query.getEntitiesWithComponents},
   * or {@link Query.iterate} — NOT here. Including optional wrappers in `createQuery` will cause
   * undefined behavior because the internal normalization relies on numeric sorting of component IDs.
   *
   * @param componentTypes - Array of **required** component types to match (do not include optional wrappers)
   * @param filter - Optional filter for additional constraints (e.g., exclude entities with certain components)
   * @returns A Query instance that can be used to iterate matching entities
   *
   * @example
   * // Create once, reuse many times (required components only)
   * const movementQuery = world.createQuery([Position, Velocity]);
   *
   * // Optional components are passed at iteration time, not creation time:
   * movementQuery.forEach([Position, { optional: Velocity }], (entity, pos, vel) => {
   *   pos.x += vel?.value?.x ?? 0;
   * });
   *
   * // With filter
   * const activeQuery = world.createQuery([Position], {
   *   negativeComponentTypes: [Disabled]
   * });
   */
  createQuery(componentTypes: EntityId<any>[], filter: QueryFilter = {}): Query {
    const sortedTypes = normalizeComponentTypes(componentTypes);
    const filterKey = serializeQueryFilter(filter);
    const key = `${sortedTypes.join(",")}${filterKey ? `|${filterKey}` : ""}`;
    return this.queryRegistry.getOrCreate(this, sortedTypes, key, filter);
  }

  /**
   * Creates a new entity builder for fluent entity configuration.
   * Useful for building entities with multiple components in a single expression.
   *
   * @returns An EntityBuilder instance
   *
   * @example
   * const entity = world.spawn()
   *   .with(Position, { x: 0, y: 0 })
   *   .with(Velocity, { x: 1, y: 1 })
   *   .build();
   * world.sync(); // Apply changes
   */
  spawn(): EntityBuilder {
    return new EntityBuilder(this);
  }

  /**
   * Spawns multiple entities with a configuration callback.
   * More efficient than calling `spawn()` multiple times when creating many entities.
   *
   * @param count - Number of entities to spawn
   * @param configure - Callback that receives an EntityBuilder and index; must return the configured builder
   * @returns Array of created entity IDs
   *
   * @example
   * const entities = world.spawnMany(100, (builder, index) => {
   *   return builder
   *     .with(Position, { x: index * 10, y: 0 })
   *     .with(Velocity, { x: 0, y: 1 });
   * });
   * world.sync();
   */
  spawnMany(count: number, configure: (builder: EntityBuilder, index: number) => EntityBuilder): EntityId[] {
    const entities: EntityId[] = [];
    for (let i = 0; i < count; i++) {
      const builder = new EntityBuilder(this);
      entities.push(configure(builder, i).build());
    }
    return entities;
  }

  /**
   * Releases a cached query and frees its resources if no longer needed.
   * Call this when you're done using a query to allow the world to clean up its cache entry.
   *
   * @param query - The query to release
   *
   * @example
   * const query = world.createQuery([Position]);
   * // ... use query ...
   * world.releaseQuery(query); // Optional cleanup
   */
  releaseQuery(query: Query): void {
    this.queryRegistry.release(query);
  }

  /**
   * Returns all archetypes that contain entities with the specified components.
   * Used internally for query optimization but can be useful for debugging.
   *
   * @param componentTypes - Array of component types to match
   * @returns Array of Archetype objects containing matching components
   * @internal
   */
  getMatchingArchetypes(componentTypes: EntityId<any>[]): Archetype[] {
    return this.archetypeManager.getMatchingArchetypes(componentTypes);
  }

  /**
   * Queries entities with specific components.
   * Returns an array of entity IDs that have all specified components.
   * For simpler use cases, prefer using `createQuery()` with `forEach()` which is cached and more efficient.
   *
   * @param componentTypes - Array of component types to query
   * @returns Array of entity IDs matching the query
   *
   * @example
   * const entities = world.query([Position, Velocity]);
   */
  query(componentTypes: EntityId<any>[]): EntityId[];
  /**
   * Queries entities with specific components and returns their component data.
   *
   * @template T - The tuple of component types
   * @param componentTypes - Array of component types to query
   * @param includeComponents - Must be `true` to include component data
   * @returns Array of objects with entity and component data
   *
   * @example
   * const results = world.query([Position, Velocity], true);
   * results.forEach(({ entity, components: [pos, vel] }) => {
   *   pos.x += vel.x;
   * });
   */
  query<const T extends readonly EntityId<any>[]>(
    componentTypes: T,
    includeComponents: true,
  ): Array<{ entity: EntityId; components: ComponentTuple<T> }>;
  query(
    componentTypes: EntityId<any>[],
    includeComponents?: boolean,
  ): EntityId[] | Array<{ entity: EntityId; components: any }> {
    const matchingArchetypes = this.getMatchingArchetypes(componentTypes);

    if (includeComponents) {
      const result: Array<{ entity: EntityId; components: any }> = [];
      for (const archetype of matchingArchetypes) {
        archetype.appendEntitiesWithComponents(componentTypes as EntityId<any>[], result);
      }
      return result;
    } else {
      const result: EntityId[] = [];
      for (const archetype of matchingArchetypes) {
        for (const entity of archetype.getEntities()) {
          result.push(entity);
        }
      }
      return result;
    }
  }

  // Delegators to the extracted ArchetypeManager (keeps public + internal call sites unchanged).
  private ensureArchetype(componentTypes: Iterable<EntityId<any>>): Archetype {
    return this.archetypeManager.ensureArchetype(componentTypes);
  }

  private cleanupArchetypesReferencingEntity(entityId: EntityId): void {
    this.archetypeManager.cleanupArchetypesReferencingEntity(entityId);
  }

  private archetypeMatchesHook(archetype: Archetype, entry: LifecycleHookEntry): boolean {
    return this.archetypeManager.archetypeMatchesHook(archetype, entry);
  }

  /**
   * Serializes the entire world state to a plain JavaScript object.
   * This creates a "memory snapshot" that can be stored or transmitted.
   * The snapshot can be restored using `new World(snapshot)`.
   *
   * **Note:** This is NOT automatically persistent storage. To persist data,
   * you must serialize the returned object to JSON or another format yourself.
   *
   * @returns A serializable object representing the world state
   *
   * @example
   * // Create snapshot
   * const snapshot = world.serialize();
   *
   * // Save to storage (example)
   * localStorage.setItem('save', JSON.stringify(snapshot));
   *
   * // Later, restore from snapshot
   * const savedData = JSON.parse(localStorage.getItem('save'));
   * const newWorld = new World(savedData);
   */
  // Thin delegator to the extracted CommandExecutor for cascade paths (destroy* methods).
  private removeComponentImmediate(entityId: EntityId, componentType: EntityId<any>, targetEntityId: EntityId): void {
    this.commandExecutor.removeComponentImmediate(entityId, componentType, targetEntityId);
  }

  private createHooksContext(): HooksContext {
    // The executor owns the current HooksContext; expose for any remaining internal use.
    return (
      (this.commandExecutor as any).getHooksContext?.() ?? {
        multiHooks: this.hooks,
        has: (eid, ct) => this.has(eid, ct),
        get: (eid, ct) => this.get(eid, ct),
        getOptional: (eid, ct) => this.getOptional(eid, ct),
      }
    );
  }

  serialize(): SerializedWorld {
    return serializeWorld(
      this.archetypeManager.archetypes as Archetype[],
      this.componentEntities,
      this.entityIdManager,
    );
  }
}
