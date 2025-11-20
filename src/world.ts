import { Archetype, MISSING_COMPONENT } from "./archetype";
import { ComponentChangeset } from "./changeset";
import { CommandBuffer, type Command } from "./command-buffer";
import type { ComponentId, EntityId, WildcardRelationId } from "./entity";
import {
  decodeRelationId,
  EntityIdManager,
  getComponentIdByName,
  getComponentNameById,
  getDetailedIdType,
  isRelationId,
  relation,
} from "./entity";
import { MultiMap } from "./multi-map";
import { Query } from "./query";
import { serializeQueryFilter, type QueryFilter } from "./query-filter";
import type { System } from "./system";
import { SystemScheduler } from "./system-scheduler";
import type { ComponentTuple, LifecycleHook } from "./types";
import { getOrCreateWithSideEffect } from "./utils";

/**
 * World class for ECS architecture
 * Manages entities, components, and systems
 */
export class World<UpdateParams extends any[] = []> {
  // Core data structures for entity and archetype management
  /** Manages allocation and deallocation of entity IDs */
  private entityIdManager = new EntityIdManager();

  /** Array of all archetypes in the world */
  private archetypes: Archetype[] = [];

  /** Maps archetype signatures (component type signatures) to archetype instances */
  private archetypeBySignature = new Map<string, Archetype>();

  /** Maps entity IDs to their current archetype */
  private entityToArchetype = new Map<EntityId, Archetype>();

  /** Maps component types to arrays of archetypes that contain them */
  private archetypesByComponent = new Map<EntityId<any>, Archetype[]>();

  /** Tracks which entities reference each entity as a component type */
  private entityReferences = new Map<EntityId, MultiMap<EntityId, EntityId>>();

  // Query management
  /** Array of all active queries for archetype change notifications */
  private queries: Query[] = [];

  /** Cache for queries keyed by component types and filter signatures */
  private queryCache = new Map<string, { query: Query; refCount: number }>();

  // System management
  /** Schedules and executes systems in dependency order */
  private systemScheduler = new SystemScheduler<UpdateParams>();

  // Command execution
  /** Buffers structural changes for deferred execution */
  private commandBuffer = new CommandBuffer((entityId, commands) => this.executeEntityCommands(entityId, commands));

  // Lifecycle and configuration
  /** Stores lifecycle hooks for component and relation events */
  private hooks = new Map<EntityId<any>, Set<LifecycleHook<any>>>();

  /** Set of component IDs marked as exclusive relations */
  private exclusiveComponents = new Set<EntityId>();
  /** Set of component IDs that will cascade delete when the relation target is deleted */
  private cascadeDeleteComponents = new Set<EntityId>();

  /**
   * Create a new World.
   * If an optional snapshot object is provided (previously produced by `world.serialize()`),
   * the world will be restored from that snapshot. The snapshot may contain non-JSON values.
   */
  constructor(snapshot?: SerializedWorld) {
    // If snapshot provided, restore world state
    if (snapshot && typeof snapshot === "object") {
      if (snapshot.entityManager) {
        this.entityIdManager.deserializeState(snapshot.entityManager);
      }

      // Restore entities and their components
      if (Array.isArray(snapshot.entities)) {
        for (const entry of snapshot.entities) {
          const entityId = entry.id as EntityId;
          const componentsArray: SerializedComponent[] = entry.components || [];

          const componentMap = new Map<EntityId<any>, any>();
          const componentTypes: EntityId<any>[] = [];

          for (const componentEntry of componentsArray) {
            const componentTypeRaw = componentEntry.type;
            let componentType: EntityId<any>;

            if (typeof componentTypeRaw === "number") {
              componentType = componentTypeRaw as EntityId<any>;
            } else if (typeof componentTypeRaw === "string") {
              // Component name lookup
              const compId = getComponentIdByName(componentTypeRaw);
              if (compId === undefined) {
                throw new Error(`Unknown component name in snapshot: ${componentTypeRaw}`);
              }
              componentType = compId;
            } else if (
              typeof componentTypeRaw === "object" &&
              componentTypeRaw !== null &&
              typeof componentTypeRaw.component === "string"
            ) {
              // Component name lookup
              const compId = getComponentIdByName(componentTypeRaw.component);
              if (compId === undefined) {
                throw new Error(`Unknown component name in snapshot: ${componentTypeRaw.component}`);
              }
              if (typeof componentTypeRaw.target === "string") {
                const targetCompId = getComponentIdByName(componentTypeRaw.target);
                if (targetCompId === undefined) {
                  throw new Error(`Unknown target component name in snapshot: ${componentTypeRaw.target}`);
                }
                componentType = relation(compId, targetCompId);
              } else {
                componentType = relation(compId, componentTypeRaw.target as EntityId);
              }
            } else {
              throw new Error(`Invalid component type in snapshot: ${JSON.stringify(componentTypeRaw)}`);
            }
            componentMap.set(componentType, componentEntry.value);
            componentTypes.push(componentType);
          }

          const archetype = this.ensureArchetype(componentTypes);
          archetype.addEntity(entityId, componentMap);
          this.entityToArchetype.set(entityId, archetype);

          // Update reverse index based on component types
          for (const compType of componentTypes) {
            const detailedType = getDetailedIdType(compType);
            if (detailedType.type === "entity-relation") {
              const targetEntityId = detailedType.targetId!;
              this.trackEntityReference(entityId, compType, targetEntityId);
            } else if (detailedType.type === "entity") {
              this.trackEntityReference(entityId, compType, compType);
            }
          }
        }
      }
    }
  }

  /**
   * Generate a signature string for component types array
   * @returns A string signature for the component types
   */
  private createArchetypeSignature(componentTypes: EntityId<any>[]): string {
    return componentTypes.join(",");
  }

  /**
   * Create a new entity
   * @returns The ID of the newly created entity
   */
  new(): EntityId {
    const entityId = this.entityIdManager.allocate();
    // Create empty archetype for entities with no components
    let emptyArchetype = this.ensureArchetype([]);
    emptyArchetype.addEntity(entityId, new Map());
    this.entityToArchetype.set(entityId, emptyArchetype);
    return entityId;
  }

  /**
   * Destroy an entity and remove all its components (immediate execution)
   */
  private destroyEntityImmediate(entityId: EntityId): void {
    // Implement BFS-style cascade deletion for entity relations where cascade is enabled
    const queue: EntityId[] = [entityId];
    const visited = new Set<EntityId>();

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const archetype = this.entityToArchetype.get(cur);
      if (!archetype) {
        continue; // Entity doesn't exist
      }

      // Collect references to this entity and iterate
      const componentReferences = Array.from(this.getEntityReferences(cur));
      for (const [sourceEntityId, componentType] of componentReferences) {
        // For each referencing entity, decide whether to cascade delete or simply remove the component
        const sourceArchetype = this.entityToArchetype.get(sourceEntityId);
        if (!sourceArchetype) continue;

        const detailedType = getDetailedIdType(componentType);
        // Cascade only applies to entity relations (not component-relation)
        if (detailedType.type === "entity-relation" && this.cascadeDeleteComponents.has(detailedType.componentId!)) {
          // Enqueue the referencing entity for deletion (cascade)
          if (!visited.has(sourceEntityId)) {
            queue.push(sourceEntityId);
          }
          continue;
        }

        // Non-cascade behavior: remove the relation component from the source entity
        const currentComponents = new Map<EntityId<any>, any>();
        let removedComponent = sourceArchetype.get(sourceEntityId, componentType);
        for (const archetypeComponentType of sourceArchetype.componentTypes) {
          if (archetypeComponentType !== componentType) {
            const componentData = sourceArchetype.get(sourceEntityId, archetypeComponentType);
            currentComponents.set(archetypeComponentType, componentData);
          }
        }

        const newArchetype = this.ensureArchetype(currentComponents.keys());

        // Remove from current archetype
        sourceArchetype.removeEntity(sourceEntityId);
        if (sourceArchetype.getEntities().length === 0) {
          this.cleanupEmptyArchetype(sourceArchetype);
        }

        // Add to new archetype
        newArchetype.addEntity(sourceEntityId, currentComponents);
        this.entityToArchetype.set(sourceEntityId, newArchetype);

        // Remove from component reverse index
        this.untrackEntityReference(sourceEntityId, componentType, cur);

        // Trigger component removed hooks
        this.triggerLifecycleHooks(sourceEntityId, new Map(), new Map([[componentType, removedComponent]]));
      }

      // Clean up the reverse index for this entity
      this.entityReferences.delete(cur);

      // Remove the entity itself
      archetype.removeEntity(cur);
      if (archetype.getEntities().length === 0) {
        this.cleanupEmptyArchetype(archetype);
      }
      this.entityToArchetype.delete(cur);
      this.entityIdManager.deallocate(cur);
    }
  }

  /**
   * Check if an entity exists
   */
  exists(entityId: EntityId): boolean {
    return this.entityToArchetype.has(entityId);
  }

  /**
   * Add a component to an entity (deferred)
   */
  set(entityId: EntityId, componentType: EntityId<void>): void;
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  set(entityId: EntityId, componentType: EntityId, component?: any): void {
    if (!this.exists(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    // Validate component type
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }
    if (detailedType.type === "wildcard-relation") {
      throw new Error(`Cannot directly add wildcard relation components: ${componentType}`);
    }

    this.commandBuffer.set(entityId, componentType, component);
  }

  /**
   * Remove a component from an entity (deferred)
   */
  remove<T>(entityId: EntityId, componentType: EntityId<T>): void {
    if (!this.exists(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    // Validate component type
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }

    this.commandBuffer.remove(entityId, componentType);
  }

  /**
   * Destroy an entity and remove all its components (deferred)
   */
  delete(entityId: EntityId): void {
    this.commandBuffer.delete(entityId);
  }

  /**
   * Check if an entity has a specific component
   */
  has<T>(entityId: EntityId, componentType: EntityId<T>): boolean {
    const archetype = this.entityToArchetype.get(entityId);
    return archetype ? archetype.componentTypes.includes(componentType) : false;
  }

  /**
   * Get component data for a specific entity and wildcard relation type
   * Returns an array of all matching relation instances
   * @param entityId The entity
   * @param componentType The wildcard relation type
   * @returns Array of [targetEntityId, componentData] pairs for all matching relations
   */
  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][];
  /**
   * Get component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @returns The component data
   */
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    // Check if entity has the component before attempting to get it
    // Note: undefined is a valid component value, so we cannot use undefined to check existence
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type !== "wildcard-relation") {
      // For regular components, check if the component type exists in the archetype
      if (!archetype.componentTypes.includes(componentType)) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
    }

    return archetype.get(entityId, componentType);
  }

  /**
   * Register a system with optional dependencies
   */
  registerSystem(system: System<UpdateParams>, additionalDeps: System<UpdateParams>[] = []): void {
    this.systemScheduler.addSystem(system, additionalDeps);
  }

  /**
   * Register a lifecycle hook for component or wildcard relation events
   */
  hook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void {
    if (!this.hooks.has(componentType)) {
      this.hooks.set(componentType, new Set());
    }
    this.hooks.get(componentType)!.add(hook);

    if (hook.on_init !== undefined) {
      this.archetypesByComponent.get(componentType)?.forEach((archetype) => {
        const entities = archetype.getEntityToIndexMap();
        const componentData = archetype.getComponentData<T>(componentType);
        for (const [entity, index] of entities) {
          const data = componentData[index];
          const value = (data === MISSING_COMPONENT ? undefined : data) as T;
          hook.on_init?.(entity, componentType, value);
        }
      });
    }
  }

  /**
   * Unregister a lifecycle hook for component or wildcard relation events
   */
  unhook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void {
    const hooks = this.hooks.get(componentType);
    if (hooks) {
      hooks.delete(hook);
      if (hooks.size === 0) {
        this.hooks.delete(componentType);
      }
    }
  }

  /**
   * Mark a component as exclusive relation
   * For exclusive relations, an entity can have at most one relation per base component
   */
  setExclusive(componentId: EntityId): void {
    this.exclusiveComponents.add(componentId);
  }

  /**
   * Mark a component as cascade-delete relation
   * For cascade relations, when the relation target entity is deleted,
   * the referencing entity will also be deleted (cascade).
   * Only applicable to entity-relation components
   */
  setCascadeDelete(componentId: EntityId): void {
    this.cascadeDeleteComponents.add(componentId);
  }

  /**
   * Update the world (run all systems in dependency order)
   * This function is synchronous when all systems are synchronous,
   * and asynchronous (returns a Promise) when any system is asynchronous.
   */
  update(...params: UpdateParams): Promise<void> | void {
    const result = this.systemScheduler.update(...params);
    if (result instanceof Promise) {
      return result.then(() => this.commandBuffer.execute());
    } else {
      this.commandBuffer.execute();
    }
  }

  /**
   * Execute all deferred commands immediately without running systems
   */
  sync(): void {
    this.commandBuffer.execute();
  }

  /**
   * Create a cached query for efficient entity lookups
   * @returns A Query object for the specified component types and filter
   */
  createQuery(componentTypes: EntityId<any>[], filter: QueryFilter = {}): Query {
    // Build a deterministic key for the query (component types sorted + filter negative components sorted)
    const sortedTypes = [...componentTypes].sort((a, b) => a - b);
    const filterKey = serializeQueryFilter(filter);
    const key = `${this.createArchetypeSignature(sortedTypes)}${filterKey ? `|${filterKey}` : ""}`;

    const cached = this.queryCache.get(key);
    if (cached) {
      cached.refCount++;
      return cached.query;
    }

    const query = new Query(this, sortedTypes, filter);
    this.queryCache.set(key, { query, refCount: 1 });
    return query;
  }

  /**
   * @internal Register a query for archetype update notifications
   */
  _registerQuery(query: Query): void {
    this.queries.push(query);
  }

  /**
   * @internal Unregister a query
   */
  _unregisterQuery(query: Query): void {
    const index = this.queries.indexOf(query);
    if (index !== -1) {
      this.queries.splice(index, 1);
    }
  }

  /**
   * Release a query reference obtained from createQuery.
   * Decrements the refCount and fully disposes the query when it reaches zero.
   */
  releaseQuery(query: Query): void {
    for (const [k, v] of this.queryCache.entries()) {
      if (v.query === query) {
        v.refCount--;
        if (v.refCount <= 0) {
          this.queryCache.delete(k);
          this._unregisterQuery(query);
          // Fully dispose the query (will unregister it from notification list)
          v.query._disposeInternal();
        }
        return;
      }
    }
  }

  /**
   * @internal Get archetypes that match specific component types (for internal use by queries)
   */
  getMatchingArchetypes(componentTypes: EntityId<any>[]): Archetype[] {
    if (componentTypes.length === 0) {
      return [...this.archetypes];
    }

    // Separate regular components from wildcard relations
    const regularComponents: EntityId<any>[] = [];
    const wildcardRelations: { componentId: EntityId<any>; relationId: EntityId<any> }[] = [];

    for (const componentType of componentTypes) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "wildcard-relation") {
        wildcardRelations.push({
          componentId: detailedType.componentId!,
          relationId: componentType,
        });
      } else {
        regularComponents.push(componentType);
      }
    }

    // Get archetypes for regular components
    let matchingArchetypes: Archetype[] = [];

    if (regularComponents.length > 0) {
      const sortedRegularTypes = [...regularComponents].sort((a, b) => a - b);

      if (sortedRegularTypes.length === 1) {
        const componentType = sortedRegularTypes[0]!;
        matchingArchetypes = this.archetypesByComponent.get(componentType) || [];
      } else {
        // Multi-component query - find intersection of archetypes
        const archetypeLists = sortedRegularTypes.map((type) => this.archetypesByComponent.get(type) || []);
        const firstList = archetypeLists[0] || [];
        const intersection = new Set<Archetype>();

        // Find archetypes that contain all required components
        for (const archetype of firstList) {
          let hasAllComponents = true;
          for (let listIndex = 1; listIndex < archetypeLists.length; listIndex++) {
            const otherList = archetypeLists[listIndex]!;
            if (!otherList.includes(archetype)) {
              hasAllComponents = false;
              break;
            }
          }
          if (hasAllComponents) {
            intersection.add(archetype);
          }
        }

        matchingArchetypes = Array.from(intersection);
      }
    } else {
      // No regular components, start with all archetypes
      matchingArchetypes = [...this.archetypes];
    }

    // Filter by wildcard relations
    for (const wildcard of wildcardRelations) {
      // Keep only archetypes that have the component
      matchingArchetypes = matchingArchetypes.filter((archetype) =>
        archetype.componentTypes.some((archetypeType) => {
          if (!isRelationId(archetypeType)) return false;
          const decoded = decodeRelationId(archetypeType);
          return decoded.componentId === wildcard.componentId;
        }),
      );
    }

    return matchingArchetypes;
  }

  /**
   * Query entities with specific components
   * @returns Array of entity IDs that have all the specified components
   */
  query(componentTypes: EntityId<any>[]): EntityId[];
  query<const T extends readonly EntityId<any>[]>(
    componentTypes: T,
    includeComponents: true,
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }>;
  query(
    componentTypes: EntityId<any>[],
    includeComponents?: boolean,
  ):
    | EntityId[]
    | Array<{
        entity: EntityId;
        components: any;
      }> {
    const matchingArchetypes = this.getMatchingArchetypes(componentTypes);

    if (includeComponents) {
      const result: Array<{
        entity: EntityId;
        components: any;
      }> = [];

      for (const archetype of matchingArchetypes) {
        const entitiesWithData = archetype.getEntitiesWithComponents(componentTypes as EntityId<any>[]);
        result.push(...entitiesWithData);
      }

      return result;
    } else {
      const result: EntityId[] = [];
      for (const archetype of matchingArchetypes) {
        result.push(...archetype.getEntities());
      }
      return result;
    }
  }

  /**
   * @internal Execute commands for a single entity (for internal use by CommandBuffer)
   * @returns ComponentChangeset describing the changes made
   */
  executeEntityCommands(entityId: EntityId, commands: Command[]): ComponentChangeset {
    // Track component changes using ComponentChangeset
    const changeset = new ComponentChangeset();

    // Check if entity should be destroyed
    const hasDestroy = commands.some((cmd) => cmd.type === "destroy");
    if (hasDestroy) {
      this.destroyEntityImmediate(entityId);
      return changeset;
    }

    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) {
      return changeset; // Entity doesn't exist, nothing to do
    }

    // Process commands to determine final state
    for (const command of commands) {
      switch (command.type) {
        case "set":
          if (command.componentType) {
            const detailedType = getDetailedIdType(command.componentType);
            // For exclusive relations, remove existing relations with the same base component
            if (
              (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
              this.exclusiveComponents.has(detailedType.componentId!)
            ) {
              for (const componentType of currentArchetype.componentTypes) {
                const componentDetailedType = getDetailedIdType(componentType);
                if (
                  (componentDetailedType.type === "entity-relation" ||
                    componentDetailedType.type === "component-relation") &&
                  componentDetailedType.componentId === detailedType.componentId
                ) {
                  changeset.delete(componentType);
                }
              }
            }
            changeset.set(command.componentType, command.component);
          }
          break;
        case "delete":
          if (command.componentType) {
            const detailedType = getDetailedIdType(command.componentType);
            if (detailedType.type === "wildcard-relation") {
              // For wildcard relation removal, find all matching relation components
              const baseComponentId = detailedType.componentId!;
              for (const componentType of currentArchetype.componentTypes) {
                const componentDetailedType = getDetailedIdType(componentType);
                if (
                  componentDetailedType.type === "entity-relation" ||
                  componentDetailedType.type === "component-relation"
                ) {
                  if (componentDetailedType.componentId === baseComponentId) {
                    changeset.delete(componentType);
                  }
                }
              }
            } else {
              changeset.delete(command.componentType);
            }
          }
          break;
      }
    }

    const finalComponentTypes = changeset.getFinalComponentTypes(currentArchetype.componentTypes);
    const removedCompoents = new Map<EntityId<any>, any>();

    if (finalComponentTypes) {
      // Move to new archetype with final component state
      const newArchetype = this.ensureArchetype(finalComponentTypes);

      // Remove from current archetype and get current components
      const currentComponents = currentArchetype.removeEntity(entityId)!;

      for (const componentType of changeset.removes) {
        removedCompoents.set(componentType, currentComponents.get(componentType));
      }

      // Add to new archetype with final component data
      newArchetype.addEntity(entityId, changeset.applyTo(currentComponents));
      this.entityToArchetype.set(entityId, newArchetype);
    } else {
      // Same archetype, just update component data
      for (const [componentType, component] of changeset.adds) {
        currentArchetype.set(entityId, componentType, component);
      }
      // Removals are already handled by not including them in finalComponents
    }

    // Update component reverse index for removed components
    for (const componentType of changeset.removes) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "entity-relation") {
        // For relation components, track the target entity
        const targetEntityId = detailedType.targetId!;
        this.untrackEntityReference(entityId, componentType, targetEntityId);
      } else if (detailedType.type === "entity") {
        // For direct entity usage as component type, track the component type itself
        this.untrackEntityReference(entityId, componentType, componentType);
      }
    }

    // Update component reverse index for added components
    for (const [componentType, component] of changeset.adds) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "entity-relation") {
        // For relation components, track the target entity
        const targetEntityId = detailedType.targetId!;
        this.trackEntityReference(entityId, componentType, targetEntityId);
      } else if (detailedType.type === "entity") {
        // For direct entity usage as component type, track the component type itself
        this.trackEntityReference(entityId, componentType, componentType);
      }
    }

    // Trigger component lifecycle hooks
    this.triggerLifecycleHooks(entityId, changeset.adds, removedCompoents);

    return changeset;
  }

  /**
   * Get or create an archetype for the given component types
   * @returns The archetype for the given component types
   */
  private ensureArchetype(componentTypes: Iterable<EntityId<any>>): Archetype {
    const sortedTypes = Array.from(componentTypes).sort((a, b) => a - b);
    const hashKey = this.createArchetypeSignature(sortedTypes);

    return getOrCreateWithSideEffect(this.archetypeBySignature, hashKey, () => {
      // Create new archetype
      const newArchetype = new Archetype(sortedTypes);
      this.archetypes.push(newArchetype);

      // Update reverse index for each component type
      for (const componentType of sortedTypes) {
        const archetypes = this.archetypesByComponent.get(componentType) || [];
        archetypes.push(newArchetype);
        this.archetypesByComponent.set(componentType, archetypes);
      }

      // Notify all queries to check the new archetype
      for (const query of this.queries) {
        query.checkNewArchetype(newArchetype);
      }

      return newArchetype;
    });
  }

  /**
   * Add a component reference to the reverse index when an entity is used as a component type
   * @param sourceEntityId The entity that has the component
   * @param componentType The component type (which may be an entity ID used as component type)
   * @param targetEntityId The entity being used as component type
   */
  private trackEntityReference(sourceEntityId: EntityId, componentType: EntityId, targetEntityId: EntityId): void {
    if (!this.entityReferences.has(targetEntityId)) {
      this.entityReferences.set(targetEntityId, new MultiMap());
    }
    this.entityReferences.get(targetEntityId)!.add(sourceEntityId, componentType);
  }

  /**
   * Remove a component reference from the reverse index
   * @param sourceEntityId The entity that has the component
   * @param componentType The component type
   * @param targetEntityId The entity being used as component type
   */
  private untrackEntityReference(sourceEntityId: EntityId, componentType: EntityId, targetEntityId: EntityId): void {
    const references = this.entityReferences.get(targetEntityId);
    if (references) {
      references.remove(sourceEntityId, componentType);
      if (references.keyCount === 0) {
        this.entityReferences.delete(targetEntityId);
      }
    }
  }

  /**
   * Get all component references where a target entity is used as a component type
   * @param targetEntityId The target entity
   * @returns A MultiMap of sourceEntityId to componentTypes that reference the target entity
   */
  private getEntityReferences(targetEntityId: EntityId): Iterable<[EntityId, EntityId]> {
    return this.entityReferences.get(targetEntityId) ?? new MultiMap();
  }

  /**
   * Remove an empty archetype from all internal data structures
   */
  private cleanupEmptyArchetype(archetype: Archetype): void {
    // Only remove if archetype is actually empty
    if (archetype.getEntities().length > 0) {
      return;
    }

    // Remove from archetypes array
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      this.archetypes.splice(index, 1);
    }

    // Remove from archetype signature map
    const hashKey = this.createArchetypeSignature(archetype.componentTypes);
    this.archetypeBySignature.delete(hashKey);

    // Remove from archetypesByComponent
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

    // Remove from queries
    for (const query of this.queries) {
      query.removeArchetype(archetype);
    }
  }

  /**
   * Execute component lifecycle hooks for added and removed components
   */
  private triggerLifecycleHooks(
    entityId: EntityId,
    addedComponents: Map<EntityId<any>, any>,
    removedComponents: Map<EntityId<any>, any>,
  ): void {
    // Trigger component added hooks
    for (const [componentType, component] of addedComponents) {
      // Trigger direct component hooks
      const directHooks = this.hooks.get(componentType);
      if (directHooks) {
        for (const lifecycleHook of directHooks) {
          lifecycleHook.on_set?.(entityId, componentType, component);
        }
      }

      // Trigger wildcard relation hooks for added components
      const detailedType = getDetailedIdType(componentType);
      if (
        detailedType.type === "entity-relation" ||
        detailedType.type === "component-relation" ||
        detailedType.type === "wildcard-relation"
      ) {
        const wildcardRelationId = relation(detailedType.componentId!, "*");
        const wildcardHooks = this.hooks.get(wildcardRelationId);
        if (wildcardHooks) {
          for (const lifecycleHook of wildcardHooks) {
            lifecycleHook.on_set?.(entityId, componentType, component);
          }
        }
      }
    }

    // Trigger component removed hooks
    for (const [componentType, component] of removedComponents) {
      // Trigger direct component hooks
      const directHooks = this.hooks.get(componentType);
      if (directHooks) {
        for (const lifecycleHook of directHooks) {
          lifecycleHook.on_remove?.(entityId, componentType, component);
        }
      }

      // Trigger wildcard relation hooks for removed components
      const detailedType = getDetailedIdType(componentType);
      if (
        detailedType.type === "entity-relation" ||
        detailedType.type === "component-relation" ||
        detailedType.type === "wildcard-relation"
      ) {
        const wildcardRelationId = relation(detailedType.componentId!, "*");
        const wildcardHooks = this.hooks.get(wildcardRelationId);
        if (wildcardHooks) {
          for (const hook of wildcardHooks) {
            hook.on_remove?.(entityId, componentType, component);
          }
        }
      }
    }
  }

  /**
   * Convert the world into a plain snapshot object.
   * This returns an in-memory structure and does not perform JSON stringification.
   * Component values are stored as-is (they may be non-JSON-serializable).
   */
  serialize(): SerializedWorld {
    const entities: SerializedEntity[] = [];

    for (const archetype of this.archetypes) {
      const dumpedEntities = archetype.dump();
      for (const { entity, components } of dumpedEntities) {
        entities.push({
          id: entity,
          components: Array.from(components.entries()).map(([rawType, value]) => {
            const detailedType = getDetailedIdType(rawType);
            let type: SerializedComponent["type"] = rawType;
            let componentName;
            switch (detailedType.type) {
              case "component":
                type = getComponentNameById(rawType as ComponentId) || rawType;
                break;
              case "entity-relation":
                componentName = getComponentNameById(detailedType.componentId);
                if (componentName) {
                  type = { component: componentName, target: detailedType.targetId! };
                }
                break;
              case "component-relation":
                componentName = getComponentNameById(detailedType.componentId);
                if (componentName) {
                  type = {
                    component: componentName,
                    target: getComponentNameById(detailedType.targetId!) || detailedType.targetId!,
                  };
                }
                break;
            }
            return { type, value: value === MISSING_COMPONENT ? undefined : value };
          }),
        });
      }
    }

    return {
      version: 1,
      entityManager: this.entityIdManager.serializeState(),
      entities,
    };
  }
}

export type SerializedWorld = {
  version: number;
  entityManager: any;
  entities: SerializedEntity[];
};

export type SerializedEntity = {
  id: number;
  components: SerializedComponent[];
};

export type SerializedComponent = {
  type: number | string | { component: string; target: number | string };
  value: any;
};
