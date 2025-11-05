import { Archetype } from "./archetype";
import { ComponentChangeset } from "./changeset";
import { CommandBuffer, type Command } from "./command-buffer";
import type { EntityId, WildcardRelationId } from "./entity";
import { EntityIdManager, getDetailedIdType, relation } from "./entity";
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
  private entityIdManager = new EntityIdManager();
  private archetypes: Archetype[] = [];
  private archetypeMap = new Map<string, Archetype>();
  private entityToArchetype = new Map<EntityId, Archetype>();
  private systemScheduler = new SystemScheduler<UpdateParams>();
  private queries: Query[] = [];
  // Cache for queries keyed by component types + filter signature
  private queryCache = new Map<string, { query: Query; refCount: number }>();
  private commandBuffer: CommandBuffer;
  private componentToArchetypes = new Map<EntityId<any>, Archetype[]>();

  /**
   * Hook storage for component and wildcard relation lifecycle events
   */
  private lifecycleHooks = new Map<EntityId<any>, Set<LifecycleHook<any>>>();

  /**
   * Reverse index tracking which entities use each entity as a component type
   * Maps entity ID to set of {sourceEntityId, componentType} pairs where componentType uses this entity
   * This includes both relation components and direct usage of entities as component types
   */
  private entityReverseIndex = new Map<EntityId, Set<{ sourceEntityId: EntityId; componentType: EntityId }>>();

  /**
   * Set of component IDs that are marked as exclusive relations
   * For exclusive relations, an entity can have at most one relation per base component
   */
  private exclusiveComponents = new Set<EntityId>();

  constructor(entityIdManager?: EntityIdManager) {
    this.entityIdManager = entityIdManager || new EntityIdManager();
    this.commandBuffer = new CommandBuffer((entityId, commands) => this.executeEntityCommands(entityId, commands));
  }

  /**
   * Generate a hash key for component types array
   */
  private getComponentTypesHash(componentTypes: EntityId<any>[]): string {
    return componentTypes.join(",");
  }

  /**
   * Create a new entity
   */
  new(): EntityId {
    const entityId = this.entityIdManager.allocate();
    // Create empty archetype for entities with no components
    let emptyArchetype = this.getOrCreateArchetype([]);
    emptyArchetype.addEntity(entityId, new Map());
    this.entityToArchetype.set(entityId, emptyArchetype);
    return entityId;
  }

  /**
   * Destroy an entity and remove all its components (immediate execution)
   */
  private _destroyEntity(entityId: EntityId): void {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      return; // Entity doesn't exist, nothing to do
    }

    // Clean up components that use this entity as a component type
    const componentReferences = this.getComponentReferences(entityId);
    for (const { sourceEntityId, componentType } of componentReferences) {
      // Directly remove the component from the source entity
      const sourceArchetype = this.entityToArchetype.get(sourceEntityId);
      if (sourceArchetype) {
        // Remove from current archetype and move to new archetype without this component
        const currentComponents = new Map<EntityId<any>, any>();
        for (const compType of sourceArchetype.componentTypes) {
          if (compType !== componentType) {
            const data = sourceArchetype.get(sourceEntityId, compType);
            if (data !== undefined) {
              currentComponents.set(compType, data);
            }
          }
        }

        const newComponentTypes = Array.from(currentComponents.keys()).sort((a, b) => a - b);
        const newArchetype = this.getOrCreateArchetype(newComponentTypes);

        // Remove from current archetype
        sourceArchetype.removeEntity(sourceEntityId);
        if (sourceArchetype.getEntities().length === 0) {
          this.removeEmptyArchetype(sourceArchetype);
        }

        // Add to new archetype
        newArchetype.addEntity(sourceEntityId, currentComponents);
        this.entityToArchetype.set(sourceEntityId, newArchetype);

        // Remove from component reverse index
        this.removeComponentReference(sourceEntityId, componentType, entityId);

        // Trigger component removed hooks
        this.executeComponentLifecycleHooks(sourceEntityId, new Map(), new Set([componentType]));
      }
    }

    // Clean up the reverse index for this entity
    this.entityReverseIndex.delete(entityId);

    archetype.removeEntity(entityId);
    if (archetype.getEntities().length === 0) {
      this.removeEmptyArchetype(archetype);
    }
    this.entityToArchetype.delete(entityId);
    this.entityIdManager.deallocate(entityId);
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
  delete<T>(entityId: EntityId, componentType: EntityId<T>): void {
    if (!this.exists(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    // Validate component type
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }

    this.commandBuffer.delete(entityId, componentType);
  }

  /**
   * Destroy an entity and remove all its components (deferred)
   */
  destroy(entityId: EntityId): void {
    this.commandBuffer.destroy(entityId);
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
   */
  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][];
  /**
   * Get component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   */
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }
    return archetype.get(entityId, componentType);
  }

  /**
   * Register a system with optional dependencies
   */
  registerSystem(system: System<UpdateParams>): void {
    this.systemScheduler.addSystem(system);
  }

  /**
   * Register a lifecycle hook for component or wildcard relation events
   */
  registerLifecycleHook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void {
    if (!this.lifecycleHooks.has(componentType)) {
      this.lifecycleHooks.set(componentType, new Set());
    }
    this.lifecycleHooks.get(componentType)!.add(hook);
  }

  /**
   * Unregister a lifecycle hook for component or wildcard relation events
   */
  unregisterLifecycleHook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void {
    const hooks = this.lifecycleHooks.get(componentType);
    if (hooks) {
      hooks.delete(hook);
      if (hooks.size === 0) {
        this.lifecycleHooks.delete(componentType);
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
   * Update the world (run all systems in dependency order)
   */
  update(...params: UpdateParams): void {
    const systems = this.systemScheduler.getExecutionOrder();
    for (const system of systems) {
      system.update(...params);
    }
    this.commandBuffer.execute();
  }

  /**
   * Execute all deferred commands immediately without running systems
   */
  sync(): void {
    this.commandBuffer.execute();
  }

  /**
   * Create a cached query for efficient entity lookups
   */
  createQuery(componentTypes: EntityId<any>[], filter: QueryFilter = {}): Query {
    // Build a deterministic key for the query (component types sorted + filter negative components sorted)
    const sortedTypes = [...componentTypes].sort((a, b) => a - b);
    const filterKey = serializeQueryFilter(filter);
    const key = `${this.getComponentTypesHash(sortedTypes)}${filterKey ? `|${filterKey}` : ""}`;

    const cached = this.queryCache.get(key);
    if (cached) {
      cached.refCount++;
      return cached.query;
    }

    const query = new Query(this, sortedTypes, filter, key);
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
    const key = query.key;
    // Fallback: try to find by identity
    for (const [k, v] of this.queryCache.entries()) {
      if (v.query === query) {
        v.refCount--;
        if (v.refCount <= 0) {
          this.queryCache.delete(k);
          // Fully dispose the query (will unregister it from notification list)
          v.query._disposeInternal();
        }
        return;
      }
    }

    const entry = this.queryCache.get(key);
    if (!entry) {
      // Nothing cached, ensure it's unregistered
      this._unregisterQuery(query);
      return;
    }

    entry.refCount--;
    if (entry.refCount <= 0) {
      this.queryCache.delete(key);
      // Fully dispose the query (will unregister it from notification list)
      entry.query._disposeInternal();
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

    for (const type of componentTypes) {
      const detailedType = getDetailedIdType(type);
      if (detailedType.type === "wildcard-relation") {
        wildcardRelations.push({
          componentId: detailedType.componentId!,
          relationId: type,
        });
      } else {
        regularComponents.push(type);
      }
    }

    // Get archetypes for regular components
    let matchingArchetypes: Archetype[] = [];

    if (regularComponents.length > 0) {
      const sortedRegularTypes = [...regularComponents].sort((a, b) => a - b);

      if (sortedRegularTypes.length === 1) {
        const componentType = sortedRegularTypes[0]!;
        matchingArchetypes = this.componentToArchetypes.get(componentType) || [];
      } else {
        // Multi-component query - find intersection of archetypes
        const archetypeLists = sortedRegularTypes.map((type) => this.componentToArchetypes.get(type) || []);
        const firstList = archetypeLists[0] || [];
        const intersection = new Set<Archetype>();

        // Find archetypes that contain all required components
        for (const archetype of firstList) {
          let hasAllComponents = true;
          for (let i = 1; i < archetypeLists.length; i++) {
            const otherList = archetypeLists[i]!;
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
      const componentArchetypes = this.componentToArchetypes.get(wildcard.componentId) || [];
      // Keep only archetypes that have the component
      matchingArchetypes = matchingArchetypes.filter((archetype) => componentArchetypes.includes(archetype));
    }

    return matchingArchetypes;
  }

  /**
   * Query entities with specific components
   */
  queryEntities(componentTypes: EntityId<any>[]): EntityId[];
  queryEntities<const T extends readonly EntityId<any>[]>(
    componentTypes: T,
    includeComponents: true,
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }>;
  queryEntities(
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
   */
  executeEntityCommands(entityId: EntityId, commands: Command[]): ComponentChangeset {
    // Track component changes using ComponentChangeset
    const changeset = new ComponentChangeset();

    // Check if entity should be destroyed
    const hasDestroy = commands.some((cmd) => cmd.type === "destroy");
    if (hasDestroy) {
      this._destroyEntity(entityId);
      return changeset;
    }

    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) {
      return changeset; // Entity doesn't exist, nothing to do
    }

    // Get current component data
    const currentComponents = new Map<EntityId<any>, any>();
    for (const componentType of currentArchetype.componentTypes) {
      const data = currentArchetype.get(entityId, componentType);
      currentComponents.set(componentType, data);
    }

    // Process commands to determine final state
    for (const cmd of commands) {
      switch (cmd.type) {
        case "set":
          if (cmd.componentType) {
            const detailedType = getDetailedIdType(cmd.componentType);
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
            changeset.set(cmd.componentType, cmd.component);
          }
          break;
        case "delete":
          if (cmd.componentType) {
            const detailedType = getDetailedIdType(cmd.componentType);
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
              changeset.delete(cmd.componentType);
            }
          }
          break;
      }
    }

    // Apply changes to current components to get final state
    const finalComponents = changeset.applyTo(currentComponents);

    // Calculate final component types
    const finalComponentTypes = changeset.getFinalComponentTypes(currentComponents);

    // Check if we need to move to a different archetype
    const currentComponentTypes = currentArchetype.componentTypes.sort((a, b) => a - b);
    const needsArchetypeChange =
      finalComponentTypes.length !== currentComponentTypes.length ||
      !finalComponentTypes.every((type, index) => type === currentComponentTypes[index]);

    if (needsArchetypeChange) {
      // Move to new archetype with final component state
      const newArchetype = this.getOrCreateArchetype(finalComponentTypes);

      // Remove from current archetype
      currentArchetype.removeEntity(entityId);

      // Add to new archetype with final component data
      newArchetype.addEntity(entityId, finalComponents);
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
        this.removeComponentReference(entityId, componentType, targetEntityId);
      } else if (detailedType.type === "entity") {
        // For direct entity usage as component type, track the component type itself
        this.removeComponentReference(entityId, componentType, componentType);
      }
    }

    // Update component reverse index for added components
    for (const [componentType, component] of changeset.adds) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "entity-relation") {
        // For relation components, track the target entity
        const targetEntityId = detailedType.targetId!;
        this.addComponentReference(entityId, componentType, targetEntityId);
      } else if (detailedType.type === "entity") {
        // For direct entity usage as component type, track the component type itself
        this.addComponentReference(entityId, componentType, componentType);
      }
    }

    // Trigger component lifecycle hooks
    this.executeComponentLifecycleHooks(entityId, changeset.adds, changeset.removes);

    return changeset;
  }

  /**
   * Get or create an archetype for the given component types
   */
  private getOrCreateArchetype(componentTypes: EntityId<any>[]): Archetype {
    const sortedTypes = [...componentTypes].sort((a, b) => a - b);
    const hashKey = this.getComponentTypesHash(sortedTypes);

    return getOrCreateWithSideEffect(this.archetypeMap, hashKey, () => {
      // Create new archetype
      const newArchetype = new Archetype(sortedTypes);
      this.archetypes.push(newArchetype);

      // Update reverse index for each component type
      for (const componentType of sortedTypes) {
        const archetypes = this.componentToArchetypes.get(componentType) || [];
        archetypes.push(newArchetype);
        this.componentToArchetypes.set(componentType, archetypes);
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
  private addComponentReference(sourceEntityId: EntityId, componentType: EntityId, targetEntityId: EntityId): void {
    if (!this.entityReverseIndex.has(targetEntityId)) {
      this.entityReverseIndex.set(targetEntityId, new Set());
    }
    this.entityReverseIndex.get(targetEntityId)!.add({ sourceEntityId, componentType });
  }

  /**
   * Remove a component reference from the reverse index
   * @param sourceEntityId The entity that has the component
   * @param componentType The component type
   * @param targetEntityId The entity being used as component type
   */
  private removeComponentReference(sourceEntityId: EntityId, componentType: EntityId, targetEntityId: EntityId): void {
    const references = this.entityReverseIndex.get(targetEntityId);
    if (references) {
      references.forEach((ref) => {
        if (ref.sourceEntityId === sourceEntityId && ref.componentType === componentType) {
          references.delete(ref);
        }
      });
      if (references.size === 0) {
        this.entityReverseIndex.delete(targetEntityId);
      }
    }
  }

  /**
   * Get all component references where a target entity is used as a component type
   * @param targetEntityId The target entity
   * @returns Array of {sourceEntityId, componentType} pairs
   */
  private getComponentReferences(
    targetEntityId: EntityId,
  ): Array<{ sourceEntityId: EntityId; componentType: EntityId }> {
    const references = this.entityReverseIndex.get(targetEntityId);
    return references ? Array.from(references) : [];
  }

  /**
   * Remove an empty archetype from all internal data structures
   */
  private removeEmptyArchetype(archetype: Archetype): void {
    // Only remove if archetype is actually empty
    if (archetype.getEntities().length > 0) {
      return;
    }

    // Remove from archetypes array
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      this.archetypes.splice(index, 1);
    }

    // Remove from archetypeMap
    const hashKey = this.getComponentTypesHash(archetype.componentTypes);
    this.archetypeMap.delete(hashKey);

    // Remove from componentToArchetypes
    for (const componentType of archetype.componentTypes) {
      const archetypes = this.componentToArchetypes.get(componentType);
      if (archetypes) {
        const compIndex = archetypes.indexOf(archetype);
        if (compIndex !== -1) {
          archetypes.splice(compIndex, 1);
          if (archetypes.length === 0) {
            this.componentToArchetypes.delete(componentType);
          }
        }
      }
    }
  }

  /**
   * Execute component lifecycle hooks for added and removed components
   */
  private executeComponentLifecycleHooks(
    entityId: EntityId,
    addedComponents: Map<EntityId<any>, any>,
    removedComponents: Set<EntityId<any>>,
  ): void {
    // Trigger component added hooks
    for (const [componentType, component] of addedComponents) {
      // Trigger direct component hooks
      const directHooks = this.lifecycleHooks.get(componentType);
      if (directHooks) {
        for (const hook of directHooks) {
          if (hook.onAdded) {
            hook.onAdded(entityId, componentType, component);
          }
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
        const wildcardHooks = this.lifecycleHooks.get(wildcardRelationId);
        if (wildcardHooks) {
          for (const hook of wildcardHooks) {
            if (hook.onAdded) {
              (hook as any).onAdded(entityId, componentType, component);
            }
          }
        }
      }
    }

    // Trigger component removed hooks
    for (const componentType of removedComponents) {
      // Trigger direct component hooks
      const directHooks = this.lifecycleHooks.get(componentType);
      if (directHooks) {
        for (const hook of directHooks) {
          if (hook.onRemoved) {
            hook.onRemoved(entityId, componentType);
          }
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
        const wildcardHooks = this.lifecycleHooks.get(wildcardRelationId);
        if (wildcardHooks) {
          for (const hook of wildcardHooks) {
            if (hook.onRemoved) {
              (hook as any).onRemoved(entityId, componentType);
            }
          }
        }
      }
    }
  }

  /**
   * Convert the world into a plain JSON-serializable object.
   * Note: component values must be JSON-serializable by the caller.
   */
  /**
   * Convert the world into a plain snapshot object.
   * This returns an in-memory structure and does not perform JSON stringification.
   * Component values are stored as-is (they may be non-JSON-serializable).
   */
  serialize(): any {
    const entities: Array<{ id: number; components: Array<{ type: number; value: any }> }> = [];

    for (const [entityId, archetype] of this.entityToArchetype.entries()) {
      const compEntries: Array<{ type: number; value: any }> = [];
      for (const compType of archetype.componentTypes) {
        const value = archetype.get(entityId as EntityId, compType as EntityId<any>);
        compEntries.push({ type: compType as number, value });
      }
      entities.push({ id: entityId as number, components: compEntries });
    }

    return {
      version: 1,
      entityManager: this.entityIdManager.serializeState(),
      exclusiveComponents: Array.from(this.exclusiveComponents),
      entities,
    };
  }

  /**
   * Deserialize a world from a previously-created snapshot object.
   * The snapshot must have been produced by `world.serialize()` and may contain
   * non-JSON values (they will be copied by reference).
   */
  static deserialize<T extends any[] = []>(obj: any): World<T> {
    if (!obj || typeof obj !== "object") {
      throw new Error("World.deserialize expects a snapshot object (not a JSON string)");
    }

    const entityManager = new EntityIdManager();
    if (obj && obj.entityManager) {
      entityManager.deserializeState(obj.entityManager);
    }

    const world = new World<T>(entityManager);

    // Restore exclusive components
    if (obj && Array.isArray(obj.exclusiveComponents)) {
      for (const id of obj.exclusiveComponents) {
        world.exclusiveComponents.add(id);
      }
    }

    // Restore entities and their components
    if (obj && Array.isArray(obj.entities)) {
      for (const entry of obj.entities) {
        const entityId = entry.id as EntityId;
        const componentsArray: Array<{ type: number; value: any }> = entry.components || [];

        const componentMap = new Map<EntityId<any>, any>();
        const componentTypes: EntityId<any>[] = [];

        for (const c of componentsArray) {
          componentMap.set(c.type as EntityId<any>, c.value);
          componentTypes.push(c.type as EntityId<any>);
        }

        const archetype = world.getOrCreateArchetype(componentTypes);
        archetype.addEntity(entityId, componentMap);
        world.entityToArchetype.set(entityId, archetype);

        // Update reverse index based on component types
        for (const compType of componentTypes) {
          const detailedType = getDetailedIdType(compType);
          if (detailedType.type === "entity-relation") {
            const targetEntityId = detailedType.targetId!;
            world.addComponentReference(entityId, compType, targetEntityId);
          } else if (detailedType.type === "entity") {
            world.addComponentReference(entityId, compType, compType);
          }
        }
      }
    }

    return world;
  }
}
