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
  isCascadeDeleteComponent,
  isDontFragmentComponent,
  isExclusiveComponent,
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

  /** Storage for dontFragment relations - maps entity ID to a map of relation type to component data */
  private dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>> = new Map();

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
        if (detailedType.type === "entity-relation" && isCascadeDeleteComponent(detailedType.componentId!)) {
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
    if (!archetype) {
      return false;
    }

    // Check regular archetype components
    if (archetype.componentTypes.includes(componentType)) {
      return true;
    }

    // Check dontFragment relations
    const detailedType = getDetailedIdType(componentType);
    if (
      (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
      isDontFragmentComponent(detailedType.componentId!)
    ) {
      // Check if entity has this dontFragment relation in the shared storage
      return this.dontFragmentRelations.get(entityId)?.has(componentType) ?? false;
    }

    return false;
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
      // For regular components, check if the component type exists in the archetype or dontFragmentRelations
      const inArchetype = archetype.componentTypes.includes(componentType);
      const isDontFragment =
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        isDontFragmentComponent(detailedType.componentId!);

      // For dontFragment relations, check if it exists in the dontFragmentRelations storage
      const hasComponent =
        inArchetype || (isDontFragment && this.dontFragmentRelations.get(entityId)?.has(componentType));

      if (!hasComponent) {
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
   * @deprecated This method has been removed. Use component options instead: component({ exclusive: true })
   * @throws Always throws an error directing to the new API
   */
  setExclusive(componentId: EntityId): void {
    throw new Error("setExclusive has been removed. Use component options instead: component({ exclusive: true })");
  }

  /**
   * Mark a component as cascade-delete relation
   * @deprecated This method has been removed. Use component options instead: component({ cascadeDelete: true })
   * @throws Always throws an error directing to the new API
   */
  setCascadeDelete(componentId: EntityId): void {
    throw new Error(
      "setCascadeDelete has been removed. Use component options instead: component({ cascadeDelete: true })",
    );
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
      // Keep only archetypes that have the component (including dontFragment relations)
      matchingArchetypes = matchingArchetypes.filter((archetype) =>
        archetype.hasRelationWithComponentId(wildcard.componentId),
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
    const changeset = new ComponentChangeset();

    // Handle entity destruction
    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.destroyEntityImmediate(entityId);
      return changeset;
    }

    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) {
      return changeset;
    }

    // Process commands to build changeset
    this.processCommands(entityId, currentArchetype, commands, changeset);

    // Apply changes to entity
    const removedComponents = this.applyChangeset(entityId, currentArchetype, changeset);

    // Update entity reference tracking
    this.updateEntityReferences(entityId, changeset);

    // Trigger lifecycle hooks
    this.triggerLifecycleHooks(entityId, changeset.adds, removedComponents);

    return changeset;
  }

  /**
   * Process commands and populate the changeset
   */
  private processCommands(
    entityId: EntityId,
    currentArchetype: Archetype,
    commands: Command[],
    changeset: ComponentChangeset,
  ): void {
    for (const command of commands) {
      if (command.type === "set" && command.componentType) {
        this.processSetCommand(entityId, currentArchetype, command.componentType, command.component, changeset);
      } else if (command.type === "delete" && command.componentType) {
        this.processDeleteCommand(entityId, currentArchetype, command.componentType, changeset);
      }
    }
  }

  /**
   * Process a set command, handling exclusive relations
   */
  private processSetCommand(
    entityId: EntityId,
    currentArchetype: Archetype,
    componentType: EntityId<any>,
    component: any,
    changeset: ComponentChangeset,
  ): void {
    const detailedType = getDetailedIdType(componentType);

    // Handle exclusive relations by removing existing relations with the same base component
    if (
      (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
      isExclusiveComponent(detailedType.componentId!)
    ) {
      this.removeExclusiveRelations(entityId, currentArchetype, detailedType.componentId!, changeset);
    }

    changeset.set(componentType, component);
  }

  /**
   * Remove all relations with the same base component (for exclusive relations)
   */
  private removeExclusiveRelations(
    entityId: EntityId,
    currentArchetype: Archetype,
    baseComponentId: EntityId<any>,
    changeset: ComponentChangeset,
  ): void {
    // Check archetype components
    for (const componentType of currentArchetype.componentTypes) {
      if (this.isRelationWithComponent(componentType, baseComponentId)) {
        changeset.delete(componentType);
      }
    }

    // Check dontFragment relations
    const entityData = currentArchetype.getEntity(entityId);
    if (entityData) {
      for (const [componentType] of entityData) {
        if (currentArchetype.componentTypes.includes(componentType)) continue;
        if (this.isRelationWithComponent(componentType, baseComponentId)) {
          changeset.delete(componentType);
        }
      }
    }
  }

  /**
   * Check if a component type is a relation with the given base component
   */
  private isRelationWithComponent(componentType: EntityId<any>, baseComponentId: EntityId<any>): boolean {
    const detailedType = getDetailedIdType(componentType);
    return (
      (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
      detailedType.componentId === baseComponentId
    );
  }

  /**
   * Process a delete command, handling wildcard relations
   */
  private processDeleteCommand(
    entityId: EntityId,
    currentArchetype: Archetype,
    componentType: EntityId<any>,
    changeset: ComponentChangeset,
  ): void {
    const detailedType = getDetailedIdType(componentType);

    if (detailedType.type === "wildcard-relation") {
      this.removeWildcardRelations(entityId, currentArchetype, detailedType.componentId!, changeset);
    } else {
      changeset.delete(componentType);
    }
  }

  /**
   * Remove all relations matching a wildcard component ID
   */
  private removeWildcardRelations(
    entityId: EntityId,
    currentArchetype: Archetype,
    baseComponentId: EntityId<any>,
    changeset: ComponentChangeset,
  ): void {
    // Check archetype components
    for (const componentType of currentArchetype.componentTypes) {
      if (this.isRelationWithComponent(componentType, baseComponentId)) {
        changeset.delete(componentType);
      }
    }

    // Check dontFragment relations
    const entityData = currentArchetype.getEntity(entityId);
    if (entityData) {
      for (const [componentType] of entityData) {
        if (currentArchetype.componentTypes.includes(componentType)) continue;
        if (this.isRelationWithComponent(componentType, baseComponentId)) {
          changeset.delete(componentType);
        }
      }
    }
  }

  /**
   * Apply changeset to entity, moving to new archetype if needed
   * @returns Map of removed components with their data
   */
  private applyChangeset(
    entityId: EntityId,
    currentArchetype: Archetype,
    changeset: ComponentChangeset,
  ): Map<EntityId<any>, any> {
    const currentEntityData = currentArchetype.getEntity(entityId);
    const allCurrentComponentTypes = currentEntityData
      ? Array.from(currentEntityData.keys())
      : currentArchetype.componentTypes;

    const finalComponentTypes = changeset.getFinalComponentTypes(allCurrentComponentTypes);
    const removedComponents = new Map<EntityId<any>, any>();

    if (finalComponentTypes) {
      // Move to new archetype
      this.moveEntityToNewArchetype(entityId, currentArchetype, finalComponentTypes, changeset, removedComponents);
    } else {
      // Update in same archetype
      this.updateEntityInSameArchetype(entityId, currentArchetype, changeset, removedComponents);
    }

    return removedComponents;
  }

  /**
   * Move entity to a new archetype with updated components
   */
  private moveEntityToNewArchetype(
    entityId: EntityId,
    currentArchetype: Archetype,
    finalComponentTypes: EntityId<any>[],
    changeset: ComponentChangeset,
    removedComponents: Map<EntityId<any>, any>,
  ): void {
    const newArchetype = this.ensureArchetype(finalComponentTypes);
    const currentComponents = currentArchetype.removeEntity(entityId)!;

    // Track removed components
    for (const componentType of changeset.removes) {
      removedComponents.set(componentType, currentComponents.get(componentType));
    }

    // Add to new archetype with updated components
    newArchetype.addEntity(entityId, changeset.applyTo(currentComponents));
    this.entityToArchetype.set(entityId, newArchetype);

    // Cleanup empty archetype
    if (currentArchetype.getEntities().length === 0) {
      this.cleanupEmptyArchetype(currentArchetype);
    }
  }

  /**
   * Update entity in same archetype (no archetype change needed)
   */
  private updateEntityInSameArchetype(
    entityId: EntityId,
    currentArchetype: Archetype,
    changeset: ComponentChangeset,
    removedComponents: Map<EntityId<any>, any>,
  ): void {
    const currentComponents = currentArchetype.getEntity(entityId)!;
    const hasDontFragmentChanges = this.hasDontFragmentChanges(changeset);

    // Track removed dontFragment components
    if (hasDontFragmentChanges) {
      for (const componentType of changeset.removes) {
        const detailedType = getDetailedIdType(componentType);
        if (
          (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
          isDontFragmentComponent(detailedType.componentId!)
        ) {
          removedComponents.set(componentType, currentComponents.get(componentType));
        }
      }
    }

    if (hasDontFragmentChanges) {
      // Re-add entity with updated components
      this.readdEntityWithUpdatedComponents(entityId, currentArchetype, currentComponents, changeset);
    } else {
      // Direct update for non-dontFragment components
      for (const [componentType, component] of changeset.adds) {
        currentArchetype.set(entityId, componentType, component);
      }
    }
  }

  /**
   * Check if changeset contains dontFragment relation changes
   */
  private hasDontFragmentChanges(changeset: ComponentChangeset): boolean {
    for (const componentType of changeset.removes) {
      const detailedType = getDetailedIdType(componentType);
      if (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        isDontFragmentComponent(detailedType.componentId!)
      ) {
        return true;
      }
    }

    for (const [componentType] of changeset.adds) {
      const detailedType = getDetailedIdType(componentType);
      if (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        isDontFragmentComponent(detailedType.componentId!)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Remove and re-add entity with updated components (for dontFragment changes)
   */
  private readdEntityWithUpdatedComponents(
    entityId: EntityId,
    archetype: Archetype,
    currentComponents: Map<EntityId<any>, any>,
    changeset: ComponentChangeset,
  ): void {
    const newComponents = new Map<EntityId<any>, any>();

    // Copy current components except those marked for removal
    for (const [ct, value] of currentComponents) {
      if (!changeset.removes.has(ct)) {
        newComponents.set(ct, value);
      }
    }

    // Add new components from changeset
    for (const [ct, value] of changeset.adds) {
      newComponents.set(ct, value);
    }

    archetype.removeEntity(entityId);
    archetype.addEntity(entityId, newComponents);
  }

  /**
   * Update entity reference tracking based on changeset
   */
  private updateEntityReferences(entityId: EntityId, changeset: ComponentChangeset): void {
    // Remove references for removed components
    for (const componentType of changeset.removes) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "entity-relation") {
        this.untrackEntityReference(entityId, componentType, detailedType.targetId!);
      } else if (detailedType.type === "entity") {
        this.untrackEntityReference(entityId, componentType, componentType);
      }
    }

    // Add references for added components
    for (const [componentType] of changeset.adds) {
      const detailedType = getDetailedIdType(componentType);
      if (detailedType.type === "entity-relation") {
        this.trackEntityReference(entityId, componentType, detailedType.targetId!);
      } else if (detailedType.type === "entity") {
        this.trackEntityReference(entityId, componentType, componentType);
      }
    }
  }

  /**
   * Get or create an archetype for the given component types
   * Filters out dontFragment relations from the archetype signature
   * @returns The archetype for the given component types (excluding dontFragment relations)
   */
  private ensureArchetype(componentTypes: Iterable<EntityId<any>>): Archetype {
    const regularTypes = this.filterRegularComponentTypes(componentTypes);
    const sortedTypes = regularTypes.sort((a, b) => a - b);
    const hashKey = this.createArchetypeSignature(sortedTypes);

    return getOrCreateWithSideEffect(this.archetypeBySignature, hashKey, () => this.createNewArchetype(sortedTypes));
  }

  /**
   * Filter out dontFragment relations from component types
   */
  private filterRegularComponentTypes(componentTypes: Iterable<EntityId<any>>): EntityId<any>[] {
    const regularTypes: EntityId<any>[] = [];

    for (const componentType of componentTypes) {
      const detailedType = getDetailedIdType(componentType);

      // Skip dontFragment relations from archetype signature
      if (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        isDontFragmentComponent(detailedType.componentId!)
      ) {
        continue;
      }

      regularTypes.push(componentType);
    }

    return regularTypes;
  }

  /**
   * Create a new archetype and register it with all tracking structures
   */
  private createNewArchetype(componentTypes: EntityId<any>[]): Archetype {
    const newArchetype = new Archetype(componentTypes, this.dontFragmentRelations);
    this.archetypes.push(newArchetype);

    // Register archetype in component index
    this.registerArchetypeInComponentIndex(newArchetype, componentTypes);

    // Notify queries about new archetype
    this.notifyQueriesOfNewArchetype(newArchetype);

    return newArchetype;
  }

  /**
   * Register archetype in the component-to-archetype index
   */
  private registerArchetypeInComponentIndex(archetype: Archetype, componentTypes: EntityId<any>[]): void {
    for (const componentType of componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType) || [];
      archetypes.push(archetype);
      this.archetypesByComponent.set(componentType, archetypes);
    }
  }

  /**
   * Notify all queries to check the new archetype
   */
  private notifyQueriesOfNewArchetype(archetype: Archetype): void {
    for (const query of this.queries) {
      query.checkNewArchetype(archetype);
    }
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
    if (archetype.getEntities().length > 0) {
      return;
    }

    this.removeArchetypeFromList(archetype);
    this.removeArchetypeFromSignatureMap(archetype);
    this.removeArchetypeFromComponentIndex(archetype);
    this.removeArchetypeFromQueries(archetype);
  }

  /**
   * Remove archetype from the main archetypes list
   */
  private removeArchetypeFromList(archetype: Archetype): void {
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      this.archetypes.splice(index, 1);
    }
  }

  /**
   * Remove archetype from the signature-to-archetype map
   */
  private removeArchetypeFromSignatureMap(archetype: Archetype): void {
    const hashKey = this.createArchetypeSignature(archetype.componentTypes);
    this.archetypeBySignature.delete(hashKey);
  }

  /**
   * Remove archetype from the component-to-archetypes index
   */
  private removeArchetypeFromComponentIndex(archetype: Archetype): void {
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
  }

  /**
   * Remove archetype from all queries
   */
  private removeArchetypeFromQueries(archetype: Archetype): void {
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
