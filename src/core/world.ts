import { ComponentChangeset } from "../commands/changeset";
import { CommandBuffer, type Command } from "../commands/command-buffer";
import { matchesFilter, serializeQueryFilter, type QueryFilter } from "../query/filter";
import type { Query } from "../query/query";
import { getOrCompute } from "../utils/utils";
import { Archetype } from "./archetype";
import { EntityBuilder } from "./builder";
import { ComponentEntityStore } from "./component-entity-store";
import { normalizeComponentTypes } from "./component-type-utils";
import { DontFragmentStoreImpl } from "./dont-fragment-store";
import type { ComponentId, EntityId, WildcardRelationId } from "./entity";
import {
  ENTITY_ID_START,
  EntityIdManager,
  RELATION_SHIFT,
  getComponentIdFromRelationId,
  getDetailedIdType,
  getTargetIdFromRelationId,
  isCascadeDeleteRelation,
  isDontFragmentRelation,
  isDontFragmentWildcard,
  isEntityRelation,
  isExclusiveComponent,
  isWildcardRelationId,
} from "./entity";
import { QueryRegistry } from "./query-registry";
import type { SerializedWorld } from "./serialization";
import type { ComponentTuple, ComponentType, LifecycleCallback, LifecycleHook, LifecycleHookEntry } from "./types";
import { isOptionalEntityId } from "./types";
import {
  applyChangeset,
  applyChangesetNoHooks,
  filterRegularComponentTypes,
  maybeRemoveWildcardMarker,
  processCommands,
  removeMatchingRelations,
  type CommandProcessorContext,
} from "./world-commands";
import {
  collectMultiHookComponents,
  triggerLifecycleHooks,
  triggerRemoveHooksForEntityDeletion,
  type HooksContext,
} from "./world-hooks";
import {
  getEntityReferences,
  trackEntityReference,
  untrackEntityReference,
  type EntityReferencesMap,
} from "./world-references";
import { deserializeWorld, serializeWorld } from "./world-serialization";

/**
 * World class for ECS architecture
 * Manages entities and components
 */
export class World {
  // Core data structures for entity and archetype management
  private entityIdManager = new EntityIdManager();
  private archetypes: Archetype[] = [];
  private archetypeBySignature = new Map<string, Archetype>();
  private entityToArchetype = new Map<EntityId, Archetype>();
  private archetypesByComponent = new Map<EntityId<any>, Archetype[]>();
  private entityReferences: EntityReferencesMap = new Map();
  /** DontFragment relation storage, shared with all Archetype instances */
  private readonly dontFragmentStore = new DontFragmentStoreImpl();
  /** Component entity (singleton) storage */
  private readonly componentEntities = new ComponentEntityStore();

  // Query registry – manages caching, ref counts, and archetype notifications
  private readonly queryRegistry = new QueryRegistry();

  // Lifecycle hooks (declared before cached contexts that reference them)
  private hooks: Set<LifecycleHookEntry> = new Set();

  // Command execution
  private commandBuffer = new CommandBuffer((entityId, commands) => this.executeEntityCommands(entityId, commands));

  // Reusable instances to reduce per-frame allocations
  private readonly _changeset = new ComponentChangeset();
  /** Cached command processor context to avoid per-entity object allocation */
  private readonly _commandCtx: CommandProcessorContext = {
    dontFragmentStore: this.dontFragmentStore,
    ensureArchetype: (ct) => this.ensureArchetype(ct),
  };
  /** Cached hooks context to avoid per-entity object allocation */
  private readonly _hooksCtx: HooksContext = {
    multiHooks: this.hooks,
    has: (eid, ct) => this.has(eid, ct),
    get: (eid, ct) => this.get(eid, ct),
    getOptional: (eid, ct) => this.getOptional(eid, ct),
  };

  constructor(snapshot?: SerializedWorld) {
    if (snapshot && typeof snapshot === "object") {
      deserializeWorld(
        {
          entityIdManager: this.entityIdManager,
          componentEntities: this.componentEntities,
          entityReferences: this.entityReferences,
          ensureArchetype: (ct) => this.ensureArchetype(ct),
          setEntityToArchetype: (eid, arch) => this.entityToArchetype.set(eid, arch),
        },
        snapshot,
      );
    }
  }

  private createArchetypeSignature(componentTypes: EntityId<any>[]): string {
    return componentTypes.join(",");
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

  private destroyEntityImmediate(entityId: EntityId): void {
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

      // Remove entity from archetype - this also cleans up dontFragment relations
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
   * Checks if an entity exists in the world.
   *
   * @param entityId - The entity identifier to check
   * @returns `true` if the entity exists, `false` otherwise
   *
   * @example
   * if (world.exists(entityId)) {
   *   console.log("Entity exists");
   * }
   */
  exists(entityId: EntityId): boolean {
    if (this.componentEntities.exists(entityId)) return true;
    return this.entityToArchetype.has(entityId);
  }

  private assertEntityExists(entityId: EntityId, label: "Entity" | "Component entity"): void {
    if (!this.exists(entityId)) {
      throw new Error(`${label} ${entityId} does not exist`);
    }
  }

  private assertComponentTypeValid(componentType: EntityId): void {
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }
  }

  private assertSetComponentTypeValid(componentType: EntityId): void {
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }
    if (detailedType.type === "wildcard-relation") {
      throw new Error(`Cannot directly add wildcard relation components: ${componentType}`);
    }
  }

  private resolveSetOperation(
    entityId: EntityId | ComponentId,
    componentTypeOrComponent?: EntityId | any,
    maybeComponent?: any,
  ): { entityId: EntityId; componentType: EntityId; component: any } {
    // Handle singleton component overload: set(componentId, data)
    if (maybeComponent === undefined && componentTypeOrComponent !== undefined) {
      const detailedType = getDetailedIdType(entityId);
      if (detailedType.type === "component" || detailedType.type === "component-relation") {
        const componentId = entityId as ComponentId;
        this.assertEntityExists(componentId, "Component entity");
        this.assertSetComponentTypeValid(componentId);
        return { entityId: componentId, componentType: componentId, component: componentTypeOrComponent };
      }
    }

    const targetEntityId = entityId as EntityId;
    const componentType = componentTypeOrComponent as EntityId;
    this.assertEntityExists(targetEntityId, "Entity");
    this.assertSetComponentTypeValid(componentType);

    return { entityId: targetEntityId, componentType, component: maybeComponent };
  }

  private resolveRemoveOperation<T>(
    entityId: EntityId | ComponentId,
    componentType?: EntityId<T>,
  ): { entityId: EntityId; componentType: EntityId } {
    // Handle singleton component overload: remove(componentId)
    if (componentType === undefined) {
      const componentId = entityId as ComponentId<T>;
      this.assertEntityExists(componentId, "Component entity");
      return { entityId: componentId, componentType: componentId };
    }

    const targetEntityId = entityId as EntityId;
    this.assertEntityExists(targetEntityId, "Entity");
    this.assertComponentTypeValid(componentType);

    return { entityId: targetEntityId, componentType };
  }

  /**
   * Adds or updates a component on an entity (or marks void component as present).
   * The change is buffered and takes effect after calling `world.sync()`.
   * If the entity does not exist, throws an error.
   *
   * @overload set(entityId: EntityId, componentType: EntityId<void>): void
   * Marks a void component as present on the entity
   *
   * @overload set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void
   * Adds or updates a component with data on the entity
   *
   * @overload set<T>(componentId: ComponentId<T>, component: NoInfer<T>): void
   * Adds or updates a singleton component (shorthand for set(componentId, componentId, component))
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component type is invalid or is a wildcard relation
   *
   * @example
   * world.set(entity, Position, { x: 10, y: 20 });
   * world.set(entity, Marker); // void component
   * world.set(GlobalConfig, { debug: true }); // singleton component
   * world.sync(); // Apply changes
   */
  set(entityId: EntityId, componentType: EntityId<void>): void;
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  set<T>(componentId: ComponentId<T>, component: NoInfer<T>): void;
  set(entityId: EntityId | ComponentId, componentTypeOrComponent?: EntityId | any, maybeComponent?: any): void {
    const {
      entityId: targetEntityId,
      componentType,
      component,
    } = this.resolveSetOperation(entityId, componentTypeOrComponent, maybeComponent);
    this.commandBuffer.set(targetEntityId, componentType, component);
  }

  /**
   * Removes a component from an entity.
   * The change is buffered and takes effect after calling `world.sync()`.
   * If the entity does not exist, throws an error.
   *
   * @overload remove<T>(entityId: EntityId, componentType: EntityId<T>): void
   * Removes a component from an entity.
   *
   * @overload remove<T>(componentId: ComponentId<T>): void
   * Removes a singleton component (shorthand for remove(componentId, componentId)).
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
   * world.remove(GlobalConfig); // Remove singleton component
   * world.sync(); // Apply changes
   */
  remove<T>(componentId: ComponentId<T>): void;
  remove<T>(entityId: EntityId, componentType: EntityId<T>): void;
  remove<T>(entityId: EntityId | ComponentId, componentType?: EntityId<T>): void {
    const { entityId: targetEntityId, componentType: targetComponentType } = this.resolveRemoveOperation(
      entityId,
      componentType,
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
   * Checks if an entity has a specific component.
   * Immediately reflects the current state without waiting for `sync()`.
   *
   * @overload has<T>(entityId: EntityId, componentType: EntityId<T>): boolean
   * Checks if a specific component type is present on the entity.
   *
   * @overload has<T>(componentId: ComponentId<T>): boolean
   * Checks if a singleton component has data (shorthand for has(componentId, componentId)).
   *
   * @template T - The component data type
   * @param entityId - The entity identifier
   * @param componentType - The component type to check
   * @returns `true` if the entity has the component, `false` otherwise
   *
   * @example
   * if (world.has(entity, Position)) {
   *   const pos = world.get(entity, Position);
   * }
   * if (world.has(GlobalConfig)) {
   *   const config = world.get(GlobalConfig);
   * }
   */
  has<T>(componentId: ComponentId<T>): boolean;
  has<T>(entityId: EntityId, componentType: EntityId<T>): boolean;
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

    if (isDontFragmentRelation(componentType)) {
      return this.dontFragmentStore.get(entityId)?.has(componentType) ?? false;
    }

    return false;
  }

  /**
   * Retrieves a component from an entity.
   * For wildcard relations, returns all relations of that type.
   * Throws an error if the component does not exist; use `has()` to check first or use `getOptional()`.
   *
   * @overload get<T>(entityId: EntityId<T>): T
   * When called with only an entity ID, retrieves the entity's primary component.
   *
   * @overload get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][]
   * For wildcard relations, returns an array of [target entity, component value] pairs.
   *
   * @overload get<T>(entityId: EntityId, componentType: EntityId<T>): T
   * Retrieves a specific component from the entity.
   *
   * @throws {Error} If the entity does not exist
   * @throws {Error} If the component does not exist on the entity
   *
   * @example
   * const position = world.get(entity, Position); // Throws if no Position
   * const relations = world.get(entity, relation(Parent, "*")); // Wildcard relation
   */
  get<T>(entityId: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][];
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
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
      const hasDontFragment = isDontFragmentRelation(componentType);
      const hasComponent = inArchetype || (hasDontFragment && this.dontFragmentStore.get(entityId)?.has(componentType));

      if (!hasComponent) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
    }

    return archetype.get(entityId, componentType);
  }

  /**
   * Safely retrieves a component from an entity without throwing an error.
   * Returns `undefined` if the component does not exist.
   * For wildcard relations, returns `undefined` if there are no relations.
   *
   * @template T - The component data type
   * @overload getOptional<T>(entityId: EntityId<T>): { value: T } | undefined
   * Retrieves the entity's primary component safely.
   *
   * @overload getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined
   * Retrieves a specific component safely.
   *
   * @throws {Error} If the entity does not exist
   *
   * @example
   * const position = world.getOptional(entity, Position);
   * if (position) {
   *   console.log(position.value.x);
   * }
   */
  getOptional<T>(entityId: EntityId<T>): { value: T } | undefined;
  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined;
  getOptional<T>(entityId: EntityId, componentType: EntityId<T> = entityId as EntityId<T>): { value: T } | undefined {
    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const relations = this.componentEntities.getWildcard(entityId, componentType as WildcardRelationId<any>);
        if (relations.length === 0) return undefined;
        return { value: relations as T };
      }
      return this.componentEntities.getOptional(entityId, componentType);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (isWildcardRelationId(componentType)) {
      // For wildcard relations, get the data and wrap in optional if non-empty
      const wildcardData = archetype.get(entityId, componentType as any);
      if (Array.isArray(wildcardData) && wildcardData.length > 0) {
        return { value: wildcardData as T };
      }
      return undefined;
    }

    return archetype.getOptional(entityId, componentType);
  }

  /**
   * Registers a lifecycle hook that responds to component changes.
   * The hook callback is invoked when components matching the specified types are added, updated, or removed.
   * @overload hook<const T extends readonly ComponentType<any>[]>(
   *   componentTypes: T,
   *   hook: LifecycleHook<T> | LifecycleCallback<T>,
   *   filter?: QueryFilter,
   * ): () => void
   * Registers a hook for multiple component types.
   * The hook is triggered when entities enter/exit the matching set.
   *
   * @param componentTypes - Component types that define the matching entity set
   * @param hook - Either a hook object with on_init/on_set/on_remove handlers, or a callback function
   * @param filter - Optional query-style filter applied to the hook match set
   * @returns A function that unsubscribes the hook when called
   *
   * @throws {Error} If no required components are specified in array overload
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
    if (typeof hook === "function") {
      const callback = hook as LifecycleCallback<any>;
      hook = {
        on_init: (entityId, ...components) => callback("init", entityId, ...components),
        on_set: (entityId, ...components) => callback("set", entityId, ...components),
        on_remove: (entityId, ...components) => callback("remove", entityId, ...components),
      } as LifecycleHook<any>;
    }

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
      hook: hook as LifecycleHook<any>,
    };
    this.hooks.add(entry);

    for (const archetype of this.archetypes) {
      if (this.archetypeMatchesHook(archetype, entry)) {
        archetype.matchingMultiHooks.add(entry);
      }
    }

    const normalizedHook = hook as LifecycleHook<any>;
    if (normalizedHook.on_init !== undefined) {
      for (const archetype of this.archetypes) {
        if (!this.archetypeMatchesHook(archetype, entry)) continue;
        for (const entityId of archetype.getEntities()) {
          const components = collectMultiHookComponents(this.createHooksContext(), entityId, componentTypes);
          normalizedHook.on_init(entityId, ...components);
        }
      }
    }

    return () => {
      this.hooks.delete(entry);
      for (const archetype of this.archetypes) {
        archetype.matchingMultiHooks.delete(entry);
      }
    };
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
    this.commandBuffer.execute();
  }

  /**
   * Creates a cached query for efficiently iterating entities with specific components.
   * The query is cached internally and reused across calls with the same component types and filter.
   *
   * **Important:** Store the query reference and reuse it across frames for optimal performance.
   * Creating a new query each frame defeats the caching mechanism.
   *
   * @param componentTypes - Array of component types to match
   * @param filter - Optional filter for additional constraints (e.g., without specific components)
   * @returns A Query instance that can be used to iterate matching entities
   *
   * @example
   * // Create once, reuse many times
   * const movementQuery = world.createQuery([Position, Velocity]);
   *
   * // In game loop
   * movementQuery.forEach((entity) => {
   *   const pos = world.get(entity, Position);
   *   const vel = world.get(entity, Velocity);
   *   pos.x += vel.x;
   *   pos.y += vel.y;
   * });
   *
   * // With filter
   * const activeQuery = world.createQuery([Position], {
   *   without: [Disabled]
   * });
   */
  createQuery(componentTypes: EntityId<any>[], filter: QueryFilter = {}): Query {
    const sortedTypes = normalizeComponentTypes(componentTypes);
    const filterKey = serializeQueryFilter(filter);
    const key = `${this.createArchetypeSignature(sortedTypes)}${filterKey ? `|${filterKey}` : ""}`;
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

  _registerQuery(query: Query): void {
    this.queryRegistry.register(query);
  }

  _unregisterQuery(query: Query): void {
    this.queryRegistry.unregister(query);
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
    if (componentTypes.length === 0) {
      return [...this.archetypes];
    }

    const regularComponents: EntityId<any>[] = [];
    const wildcardRelations: { componentId: ComponentId<any>; relationId: EntityId<any> }[] = [];

    for (const componentType of componentTypes) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId !== undefined) {
          wildcardRelations.push({ componentId, relationId: componentType });
        }
      } else {
        regularComponents.push(componentType);
      }
    }

    let matchingArchetypes = this.getArchetypesWithComponents(regularComponents);

    for (const { componentId, relationId } of wildcardRelations) {
      const archetypesWithMarker = this.archetypesByComponent.get(relationId) || [];
      matchingArchetypes =
        matchingArchetypes.length === 0
          ? archetypesWithMarker
          : matchingArchetypes.filter(
              (a) => archetypesWithMarker.includes(a) || a.hasRelationWithComponentId(componentId),
            );
    }

    return matchingArchetypes;
  }

  private getArchetypesWithComponents(componentTypes: EntityId<any>[]): Archetype[] {
    if (componentTypes.length === 0) return [...this.archetypes];
    if (componentTypes.length === 1) return this.archetypesByComponent.get(componentTypes[0]!) || [];

    // Sort by list length to start intersection from the smallest set
    const archetypeLists = componentTypes
      .map((type) => this.archetypesByComponent.get(type) || [])
      .sort((a, b) => a.length - b.length);

    const shortest = archetypeLists[0]!;
    if (shortest.length === 0) return [];

    // Optimized 2-component case: filter shortest array directly against second array
    if (archetypeLists.length === 2) {
      const second = archetypeLists[1]!;
      // Use Set only for the longer list since we iterate the shorter one
      const secondSet = new Set(second);
      return shortest.filter((a) => secondSet.has(a));
    }

    // General case: Use Set-based intersection starting from the shortest list
    let result = new Set(shortest);
    for (let i = 1; i < archetypeLists.length; i++) {
      const listSet = new Set(archetypeLists[i]!);
      for (const item of result) {
        if (!listSet.has(item)) result.delete(item);
      }
      if (result.size === 0) return [];
    }

    return Array.from(result);
  }

  /**
   * Queries entities with specific components.
   * For simpler use cases, prefer using `createQuery()` with `forEach()` which is cached and more efficient.
   *
   * @overload query(componentTypes: EntityId<any>[]): EntityId[]
   * Returns an array of entity IDs that have all specified components.
   *
   * @overload query<const T extends readonly EntityId<any>[]>(
   *   componentTypes: T,
   *   includeComponents: true,
   * ): Array<{ entity: EntityId; components: ComponentTuple<T> }>
   * Returns entities along with their component data.
   *
   * @param componentTypes - Array of component types to query
   * @param includeComponents - If true, includes component data in results
   * @returns Array of entity IDs or objects with entities and components
   *
   * @example
   * // Just entity IDs
   * const entities = world.query([Position, Velocity]);
   *
   * // With components
   * const results = world.query([Position, Velocity], true);
   * results.forEach(({ entity, components: [pos, vel] }) => {
   *   pos.x += vel.x;
   * });
   */
  query(componentTypes: EntityId<any>[]): EntityId[];
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

  executeEntityCommands(entityId: EntityId, commands: Command[]): void {
    this._changeset.clear();

    // 1. Route: component entities use flat-map storage
    if (this.componentEntities.exists(entityId)) {
      this.componentEntities.executeCommands(entityId, commands);
      return;
    }

    // 2. Route: destroy uses fast path
    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.destroyEntityImmediate(entityId);
      return;
    }

    // 3. Apply structural changes
    this.applyEntityCommands(entityId, commands);
  }

  private applyEntityCommands(entityId: EntityId, commands: Command[]): void {
    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) return;

    const changeset = this._changeset;
    processCommands(entityId, currentArchetype, commands, changeset, (eid, arch, compId) => {
      if (isExclusiveComponent(compId)) {
        removeMatchingRelations(eid, arch, compId, changeset);
      }
    });

    const hasEntityRefs = changeset.removes.size > 0 || changeset.adds.size > 0;

    if (this.hooks.size === 0) {
      // Fast path: no hooks, skip removedComponents map allocation and hook triggering
      applyChangesetNoHooks(this._commandCtx, entityId, currentArchetype, changeset, this.entityToArchetype);
      if (hasEntityRefs) {
        this.updateEntityReferences(entityId, changeset);
      }
      return;
    }

    const { removedComponents, newArchetype } = applyChangeset(
      this._commandCtx,
      entityId,
      currentArchetype,
      changeset,
      this.entityToArchetype,
    );

    if (hasEntityRefs) {
      this.updateEntityReferences(entityId, changeset);
    }
    triggerLifecycleHooks(
      this.createHooksContext(),
      entityId,
      changeset.adds,
      removedComponents,
      currentArchetype,
      newArchetype,
    );
  }

  private createHooksContext(): HooksContext {
    return this._hooksCtx;
  }

  private removeComponentImmediate(entityId: EntityId, componentType: EntityId<any>, targetEntityId: EntityId): void {
    const sourceArchetype = this.entityToArchetype.get(entityId);
    if (!sourceArchetype) return;

    const changeset = new ComponentChangeset();
    changeset.delete(componentType);
    maybeRemoveWildcardMarker(
      entityId,
      sourceArchetype,
      componentType,
      getComponentIdFromRelationId(componentType),
      changeset,
    );

    const removedComponent = sourceArchetype.get(entityId, componentType);
    const { newArchetype } = applyChangeset(
      this._commandCtx,
      entityId,
      sourceArchetype,
      changeset,
      this.entityToArchetype,
    );
    untrackEntityReference(this.entityReferences, entityId, componentType, targetEntityId);
    triggerLifecycleHooks(
      this.createHooksContext(),
      entityId,
      new Map(),
      new Map([[componentType, removedComponent]]),
      sourceArchetype,
      newArchetype,
    );
  }

  private updateEntityReferences(entityId: EntityId, changeset: ComponentChangeset): void {
    for (const componentType of changeset.removes) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        untrackEntityReference(this.entityReferences, entityId, componentType, targetId);
      } else if (componentType >= ENTITY_ID_START) {
        untrackEntityReference(this.entityReferences, entityId, componentType, componentType);
      }
    }

    for (const [componentType] of changeset.adds) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        trackEntityReference(this.entityReferences, entityId, componentType, targetId);
      } else if (componentType >= ENTITY_ID_START) {
        trackEntityReference(this.entityReferences, entityId, componentType, componentType);
      }
    }
  }

  private ensureArchetype(componentTypes: Iterable<EntityId<any>>): Archetype {
    const regularTypes = filterRegularComponentTypes(componentTypes);
    const sortedTypes = normalizeComponentTypes(regularTypes);
    const hashKey = this.createArchetypeSignature(sortedTypes);

    return getOrCompute(this.archetypeBySignature, hashKey, () => this.createNewArchetype(sortedTypes));
  }

  private createNewArchetype(componentTypes: EntityId<any>[]): Archetype {
    const newArchetype = new Archetype(componentTypes, this.dontFragmentStore);
    this.archetypes.push(newArchetype);

    for (const componentType of componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType) || [];
      archetypes.push(newArchetype);
      this.archetypesByComponent.set(componentType, archetypes);
    }

    this.queryRegistry.onNewArchetype(newArchetype);
    this.updateArchetypeHookMatches(newArchetype);

    return newArchetype;
  }

  private updateArchetypeHookMatches(archetype: Archetype): void {
    for (const entry of this.hooks) {
      if (this.archetypeMatchesHook(archetype, entry)) {
        archetype.matchingMultiHooks.add(entry);
      }
    }
  }

  private archetypeMatchesHook(archetype: Archetype, entry: LifecycleHookEntry): boolean {
    return (
      entry.requiredComponents.every((c: EntityId<any>) => {
        if (isWildcardRelationId(c)) {
          if (isDontFragmentWildcard(c)) return true;
          const componentId = getComponentIdFromRelationId(c);
          return componentId !== undefined && archetype.hasRelationWithComponentId(componentId);
        }
        return archetype.componentTypeSet.has(c) || isDontFragmentRelation(c);
      }) && matchesFilter(archetype, entry.filter)
    );
  }

  private archetypeReferencesEntity(archetype: Archetype, entityId: EntityId): boolean {
    return archetype.componentTypes.some(
      (ct) => ct === entityId || (isEntityRelation(ct) && getTargetIdFromRelationId(ct) === entityId),
    );
  }

  private cleanupArchetypesReferencingEntity(entityId: EntityId): void {
    for (let i = this.archetypes.length - 1; i >= 0; i--) {
      const archetype = this.archetypes[i]!;
      if (archetype.getEntities().length === 0 && this.archetypeReferencesEntity(archetype, entityId)) {
        this.removeArchetype(archetype);
      }
    }
  }

  private removeArchetype(archetype: Archetype): void {
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      this.archetypes.splice(index, 1);
    }

    this.archetypeBySignature.delete(this.createArchetypeSignature(archetype.componentTypes));

    for (const componentType of archetype.componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType);
      if (archetypes) {
        const compIndex = archetypes.indexOf(archetype);
        if (compIndex !== -1) {
          archetypes.splice(compIndex, 1);
          if (archetypes.length === 0) {
            this.archetypesByComponent.delete(componentType);
          }
        }
      }
    }

    this.queryRegistry.onArchetypeRemoved(archetype);
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
  serialize(): SerializedWorld {
    return serializeWorld(this.archetypes, this.componentEntities, this.entityIdManager);
  }
}
