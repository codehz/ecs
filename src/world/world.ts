import { Archetype } from "../archetype/archetype";
import { DontFragmentStoreImpl } from "../archetype/store";
import { CommandBuffer, type Command } from "../commands/buffer";
import { ComponentChangeset } from "../commands/changeset";
import { ComponentEntityStore } from "../component/entity-store";
import { normalizeComponentTypes } from "../component/type-utils";
import type { ComponentId, EntityId, WildcardRelationId } from "../entity";
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
} from "../entity";
import { matchesFilter, serializeQueryFilter, type QueryFilter } from "../query/filter";
import type { Query } from "../query/query";
import { QueryRegistry } from "../query/registry";
import type { SerializedWorld } from "../storage/serialization";
import type { ComponentTuple, ComponentType, LifecycleCallback, LifecycleHook, LifecycleHookEntry } from "../types";
import { isOptionalEntityId } from "../types";
import { getOrCompute } from "../utils/utils";
import { EntityBuilder } from "./builder";
import {
  applyChangeset,
  filterRegularComponentTypes,
  maybeRemoveWildcardMarker,
  processCommands,
  removeMatchingRelations,
  type CommandProcessorContext,
} from "./commands";
import {
  collectMultiHookComponents,
  triggerLifecycleHooks,
  triggerRemoveHooksForEntityDeletion,
  type HooksContext,
} from "./hooks";
import {
  getEntityReferences,
  trackEntityReference,
  untrackEntityReference,
  type EntityReferencesMap,
} from "./references";
import { deserializeWorld, serializeWorld } from "./serialization";

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
  private archetypesByComponent = new Map<EntityId<any>, Set<Archetype>>();
  private entityReferences: EntityReferencesMap = new Map();
  /** Reverse index: entity ID → set of archetypes whose componentTypes include that entity ID */
  private entityToReferencingArchetypes = new Map<EntityId, Set<Archetype>>();
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
  private readonly _removeChangeset = new ComponentChangeset();
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
      const markerSet = this.archetypesByComponent.get(relationId);
      const archetypesWithMarker = markerSet ? Array.from(markerSet) : [];
      matchingArchetypes =
        matchingArchetypes.length === 0
          ? archetypesWithMarker
          : matchingArchetypes.filter((a) => markerSet?.has(a) || a.hasRelationWithComponentId(componentId));
    }

    return matchingArchetypes;
  }

  private getArchetypesWithComponents(componentTypes: EntityId<any>[]): Archetype[] {
    if (componentTypes.length === 0) return [...this.archetypes];
    if (componentTypes.length === 1) {
      const set = this.archetypesByComponent.get(componentTypes[0]!);
      return set ? Array.from(set) : [];
    }

    // Sort by Set size, intersect starting from the smallest
    const sets = componentTypes
      .map((type) => this.archetypesByComponent.get(type))
      .filter((s): s is Set<Archetype> => s !== undefined && s.size > 0)
      .sort((a, b) => a.size - b.size);

    if (sets.length === 0) return [];
    if (sets.length < componentTypes.length) return []; // One component has no matching archetypes

    const smallest = sets[0]!;

    // 2-component fast path
    if (sets.length === 2) {
      const other = sets[1]!;
      return Array.from(smallest).filter((a) => other.has(a));
    }

    // Multi-component intersection
    let result = new Set(smallest);
    for (let i = 1; i < sets.length; i++) {
      for (const item of result) {
        if (!sets[i]!.has(item)) result.delete(item);
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

    const hasStructuralChange = changeset.removes.size > 0 || changeset.adds.size > 0;

    if (this.hooks.size === 0) {
      // Fast path: no hooks, skip removedComponents map allocation and hook triggering
      applyChangeset(this._commandCtx, entityId, currentArchetype, changeset, this.entityToArchetype, null);
      if (hasStructuralChange) {
        this.updateEntityReferences(entityId, changeset);
      }
      return;
    }

    const removedComponents = new Map<EntityId<any>, any>();
    const newArchetype = applyChangeset(
      this._commandCtx,
      entityId,
      currentArchetype,
      changeset,
      this.entityToArchetype,
      removedComponents,
    );

    if (hasStructuralChange) {
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

    const changeset = this._removeChangeset;
    changeset.clear();
    changeset.delete(componentType);
    maybeRemoveWildcardMarker(
      entityId,
      sourceArchetype,
      componentType,
      getComponentIdFromRelationId(componentType),
      changeset,
    );

    const removedComponent = sourceArchetype.get(entityId, componentType);
    const newArchetype = applyChangeset(
      this._commandCtx,
      entityId,
      sourceArchetype,
      changeset,
      this.entityToArchetype,
      null,
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

  /** Add componentType to the reverse index if it contains an entity ID */
  private addToReferencingIndex(componentType: EntityId<any>, archetype: Archetype): void {
    const detailedType = getDetailedIdType(componentType);
    let entityId: EntityId | undefined;

    if (detailedType.type === "entity") {
      entityId = componentType as EntityId;
    } else if (detailedType.type === "entity-relation") {
      entityId = detailedType.targetId;
    }

    if (entityId !== undefined) {
      let refs = this.entityToReferencingArchetypes.get(entityId);
      if (!refs) {
        refs = new Set();
        this.entityToReferencingArchetypes.set(entityId, refs);
      }
      refs.add(archetype);
    }
  }

  /** Remove componentType from the reverse index */
  private removeFromReferencingIndex(componentType: EntityId<any>, archetype: Archetype): void {
    const detailedType = getDetailedIdType(componentType);
    let entityId: EntityId | undefined;

    if (detailedType.type === "entity") {
      entityId = componentType as EntityId;
    } else if (detailedType.type === "entity-relation") {
      entityId = detailedType.targetId;
    }

    if (entityId !== undefined) {
      const refs = this.entityToReferencingArchetypes.get(entityId);
      if (refs) {
        refs.delete(archetype);
        if (refs.size === 0) {
          this.entityToReferencingArchetypes.delete(entityId);
        }
      }
    }
  }

  private createNewArchetype(componentTypes: EntityId<any>[]): Archetype {
    const newArchetype = new Archetype(componentTypes, this.dontFragmentStore);
    this.archetypes.push(newArchetype);

    for (const componentType of componentTypes) {
      let archetypes = this.archetypesByComponent.get(componentType);
      if (!archetypes) {
        archetypes = new Set();
        this.archetypesByComponent.set(componentType, archetypes);
      }
      archetypes.add(newArchetype);

      // Update reverse index
      this.addToReferencingIndex(componentType, newArchetype);
    }

    this.queryRegistry.onNewArchetype(newArchetype);
    this.updateArchetypeHookMatches(newArchetype);

    return newArchetype;
  }

  private updateArchetypeHookMatches(archetype: Archetype): void {
    for (const entry of this.hooks) {
      if (this.archetypeMatchesHook(archetype, entry)) {
        archetype.matchingMultiHooks.add(entry);
        if (entry.matchedArchetypes) {
          entry.matchedArchetypes.add(archetype);
        }
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

  private cleanupArchetypesReferencingEntity(entityId: EntityId): void {
    const refs = this.entityToReferencingArchetypes.get(entityId);
    if (!refs) return;

    for (const archetype of refs) {
      if (archetype.getEntities().length === 0) {
        this.removeArchetype(archetype);
      }
    }
    // removeArchetype already cleans up the reverse index entries
    this.entityToReferencingArchetypes.delete(entityId);
  }

  private removeArchetype(archetype: Archetype): void {
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      // swap-and-pop: O(1) removal
      const last = this.archetypes[this.archetypes.length - 1]!;
      this.archetypes[index] = last;
      this.archetypes.pop();
    }

    this.archetypeBySignature.delete(this.createArchetypeSignature(archetype.componentTypes));

    for (const componentType of archetype.componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType);
      if (archetypes) {
        archetypes.delete(archetype);
        if (archetypes.size === 0) {
          this.archetypesByComponent.delete(componentType);
        }
      }

      // Clean up reverse index
      this.removeFromReferencingIndex(componentType, archetype);
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
