import { ComponentChangeset } from "../commands/changeset";
import { CommandBuffer, type Command } from "../commands/command-buffer";
import { serializeQueryFilter, type QueryFilter } from "../query/filter";
import { Query } from "../query/query";
import { MultiMap } from "../utils/multi-map";
import { getOrCreateWithSideEffect } from "../utils/utils";
import { Archetype, MISSING_COMPONENT } from "./archetype";
import { EntityBuilder } from "./builder";
import type { ComponentId, EntityId, WildcardRelationId } from "./entity";
import {
  EntityIdManager,
  getComponentIdFromRelationId,
  getDetailedIdType,
  getTargetIdFromRelationId,
  isCascadeDeleteRelation,
  isDontFragmentComponent,
  isDontFragmentRelation,
  isDontFragmentWildcard,
  isEntityRelation,
  isExclusiveComponent,
  isWildcardRelationId,
  relation,
} from "./entity";
import type { SerializedComponent, SerializedEntity, SerializedWorld } from "./serialization";
import { decodeSerializedId, encodeEntityId } from "./serialization";
import type { ComponentTuple, ComponentType, LifecycleHook, MultiLifecycleHook } from "./types";
import { isOptionalEntityId } from "./types";

/**
 * World class for ECS architecture
 * Manages entities and components
 */
export class World {
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

  // Command execution
  /** Buffers structural changes for deferred execution */
  private commandBuffer = new CommandBuffer((entityId, commands) => this.executeEntityCommands(entityId, commands));

  // Lifecycle and configuration
  /** Stores lifecycle hooks for component and relation events */
  private hooks = new Map<EntityId<any>, Set<LifecycleHook<any>>>();

  /** Stores multi-component lifecycle hooks */
  private multiHooks: Set<{
    componentTypes: readonly ComponentType<any>[];
    requiredComponents: EntityId<any>[];
    hook: MultiLifecycleHook<any>;
  }> = new Set();

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
          const entityId = decodeSerializedId(entry.id);
          const componentsArray: SerializedComponent[] = entry.components || [];

          const componentMap = new Map<EntityId<any>, any>();
          const componentTypes: EntityId<any>[] = [];

          for (const componentEntry of componentsArray) {
            const componentType = decodeSerializedId(componentEntry.type);
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
  new<T = void>(): EntityId<T> {
    const entityId = this.entityIdManager.allocate();
    // Create empty archetype for entities with no components
    let emptyArchetype = this.ensureArchetype([]);
    emptyArchetype.addEntity(entityId, new Map());
    this.entityToArchetype.set(entityId, emptyArchetype);
    return entityId as EntityId<T>;
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

        // Cascade only applies to entity relations (not component-relation)
        if (isCascadeDeleteRelation(componentType)) {
          // Enqueue the referencing entity for deletion (cascade)
          if (!visited.has(sourceEntityId)) {
            queue.push(sourceEntityId);
          }
          continue;
        }

        // Non-cascade behavior: remove the relation component from the source entity
        this.removeComponentImmediate(sourceEntityId, componentType, cur);
      }

      // Clean up the reverse index for this entity
      this.entityReferences.delete(cur);

      // Remove the entity itself
      archetype.removeEntity(cur);
      this.entityToArchetype.delete(cur);

      this.cleanupArchetypesReferencingEntity(cur);
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

    if (isDontFragmentRelation(componentType)) {
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
    // Skip check for wildcard relations (componentType >= 0 means not a relation)
    if (componentType >= 0 || componentType % 2 ** 42 !== 0) {
      // Not a wildcard relation - check existence
      const inArchetype = archetype.componentTypes.includes(componentType);
      const hasDontFragment = isDontFragmentRelation(componentType);

      // For dontFragment relations, check if it exists in the dontFragmentRelations storage
      const hasComponent =
        inArchetype || (hasDontFragment && this.dontFragmentRelations.get(entityId)?.has(componentType));

      if (!hasComponent) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
    }

    return archetype.get(entityId, componentType);
  }

  /**
   * Get optional component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @returns { value: T } if component exists, undefined otherwise
   */
  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (isWildcardRelationId(componentType)) {
      return undefined;
    }

    return archetype.getOptional(entityId, componentType);
  }

  /**
   * Register a lifecycle hook for component or wildcard relation events
   */
  hook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void;
  hook<const T extends readonly ComponentType<any>[]>(componentTypes: T, hook: MultiLifecycleHook<T>): void;
  hook(
    componentTypesOrSingle: EntityId<any> | readonly ComponentType<any>[],
    hook: LifecycleHook<any> | MultiLifecycleHook<any>,
  ): void {
    if (Array.isArray(componentTypesOrSingle)) {
      // Multi-component hook
      const componentTypes = componentTypesOrSingle as readonly ComponentType<any>[];
      const requiredComponents: EntityId<any>[] = [];
      for (const ct of componentTypes) {
        if (!isOptionalEntityId(ct)) {
          requiredComponents.push(ct as EntityId<any>);
        }
      }

      const entry = {
        componentTypes,
        requiredComponents,
        hook: hook as MultiLifecycleHook<any>,
      };
      this.multiHooks.add(entry);

      // Handle on_init for existing entities
      const multiHook = hook as MultiLifecycleHook<any>;
      if (multiHook.on_init !== undefined) {
        const matchingArchetypes = this.getMatchingArchetypes(requiredComponents);
        for (const archetype of matchingArchetypes) {
          for (const entityId of archetype.getEntities()) {
            const components = this.collectMultiHookComponents(entityId, componentTypes);
            multiHook.on_init(entityId, componentTypes, components);
          }
        }
      }
    } else {
      // Single-component hook
      const componentType = componentTypesOrSingle as EntityId<any>;
      if (!this.hooks.has(componentType)) {
        this.hooks.set(componentType, new Set());
      }
      this.hooks.get(componentType)!.add(hook as LifecycleHook<any>);

      const singleHook = hook as LifecycleHook<any>;
      if (singleHook.on_init !== undefined) {
        this.archetypesByComponent.get(componentType)?.forEach((archetype) => {
          const entities = archetype.getEntityToIndexMap();
          const componentData = archetype.getComponentData<any>(componentType);
          for (const [entity, index] of entities) {
            const data = componentData[index];
            const value = data === MISSING_COMPONENT ? undefined : data;
            singleHook.on_init?.(entity, componentType, value);
          }
        });
      }
    }
  }

  /**
   * Unregister a lifecycle hook for component or wildcard relation events
   */
  unhook<T>(componentType: EntityId<T>, hook: LifecycleHook<T>): void;
  unhook<const T extends readonly ComponentType<any>[]>(componentTypes: T, hook: MultiLifecycleHook<T>): void;
  unhook(
    componentTypesOrSingle: EntityId<any> | readonly ComponentType<any>[],
    hook: LifecycleHook<any> | MultiLifecycleHook<any>,
  ): void {
    if (Array.isArray(componentTypesOrSingle)) {
      // Multi-component hook
      for (const entry of this.multiHooks) {
        if (entry.hook === hook) {
          this.multiHooks.delete(entry);
          break;
        }
      }
    } else {
      // Single-component hook
      const componentType = componentTypesOrSingle as EntityId<any>;
      const hooks = this.hooks.get(componentType);
      if (hooks) {
        hooks.delete(hook as LifecycleHook<any>);
        if (hooks.size === 0) {
          this.hooks.delete(componentType);
        }
      }
    }
  }

  /**
   * Execute all deferred commands immediately
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
   * Create an EntityBuilder for convenient entity creation.
   * @returns EntityBuilder
   */
  spawn(): EntityBuilder {
    return new EntityBuilder(this);
  }

  /**
   * Spawn multiple entities using an EntityBuilder configuration callback
   * @param count number of entities
   * @param configure builder configuration callback
   * @returns Created entity IDs
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
    const wildcardRelations: { componentId: ComponentId<any>; relationId: EntityId<any> }[] = [];

    for (const componentType of componentTypes) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId !== undefined) {
          wildcardRelations.push({
            componentId,
            relationId: componentType,
          });
        }
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
      // For dontFragment components, check if wildcard marker is in archetypesByComponent
      if (isDontFragmentComponent(wildcard.componentId)) {
        // Use the wildcard marker for efficient lookup
        const archetypesWithMarker = this.archetypesByComponent.get(wildcard.relationId) || [];

        if (matchingArchetypes.length === 0) {
          // No regular components, use all archetypes with the wildcard marker
          matchingArchetypes = archetypesWithMarker;
        } else {
          // Filter to only include archetypes that have the wildcard marker
          matchingArchetypes = matchingArchetypes.filter((archetype) => archetypesWithMarker.includes(archetype));
        }
      } else {
        // For regular (non-dontFragment) relations, fall back to entity-level checking
        // This is necessary because non-dontFragment relations are in the archetype signature
        matchingArchetypes = matchingArchetypes.filter((archetype) =>
          archetype.hasRelationWithComponentId(wildcard.componentId),
        );
      }
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
    // Extract componentId if it's a relation (fast path)
    const componentId = getComponentIdFromRelationId(componentType);
    if (componentId !== undefined) {
      // Handle exclusive relations by removing existing relations with the same base component
      if (componentId !== undefined && isExclusiveComponent(componentId)) {
        this.removeExclusiveRelations(entityId, currentArchetype, componentId, changeset);
      }

      // For dontFragment relations, ensure wildcard marker is in archetype signature
      if (componentId !== undefined && isDontFragmentComponent(componentId)) {
        const wildcardMarker = relation(componentId, "*");
        // Add wildcard marker to changeset if not already in archetype
        if (!currentArchetype.componentTypes.includes(wildcardMarker)) {
          changeset.set(wildcardMarker, undefined);
        }
      }
    }

    changeset.set(componentType, component);
  }

  /**
   * Remove all relations with the same base component (for exclusive relations)
   */
  private removeExclusiveRelations(
    entityId: EntityId,
    currentArchetype: Archetype,
    baseComponentId: ComponentId<any>,
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

  private isRelationWithComponent(componentType: EntityId<any>, baseComponentId: ComponentId<any>): boolean {
    const componentId = getComponentIdFromRelationId(componentType);
    // componentId is defined only for relations (negative IDs), and excludes wildcards by matching baseComponentId
    return componentId === baseComponentId;
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
    const componentId = getComponentIdFromRelationId(componentType);

    if (isWildcardRelationId(componentType) && componentId !== undefined) {
      this.removeWildcardRelations(entityId, currentArchetype, componentId, changeset);
    } else {
      changeset.delete(componentType);

      // If removing a dontFragment relation, check if we should remove the wildcard marker
      if (componentId !== undefined && isDontFragmentComponent(componentId)) {
        // Check if there are any other dontFragment relations with the same component ID
        const wildcardMarker = relation(componentId, "*");
        const entityData = currentArchetype.getEntity(entityId);
        let hasOtherRelations = false;

        if (entityData) {
          for (const [otherComponentType] of entityData) {
            if (otherComponentType === componentType) continue; // Skip the one being removed
            if (otherComponentType === wildcardMarker) continue; // Skip wildcard marker itself
            if (changeset.removes.has(otherComponentType)) continue; // Skip if also being removed

            const otherComponentId = getComponentIdFromRelationId(otherComponentType);
            if (otherComponentId === componentId) {
              hasOtherRelations = true;
              break;
            }
          }
        }

        // If no other relations exist, remove the wildcard marker
        if (!hasOtherRelations) {
          changeset.delete(wildcardMarker);
        }
      }
    }
  }

  /**
   * Remove all relations matching a wildcard component ID
   */
  private removeWildcardRelations(
    entityId: EntityId,
    currentArchetype: Archetype,
    baseComponentId: ComponentId<any>,
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

    // If removing dontFragment relations, also remove the wildcard marker
    if (isDontFragmentComponent(baseComponentId)) {
      const wildcardMarker = relation(baseComponentId, "*");
      changeset.delete(wildcardMarker);
    }
  }

  /**
   * Remove a single component from an entity immediately, handling dontFragment relations correctly.
   * Used by destroyEntityImmediate for non-cascade relation cleanup.
   */
  private removeComponentImmediate(entityId: EntityId, componentType: EntityId<any>, targetEntityId: EntityId): void {
    const sourceArchetype = this.entityToArchetype.get(entityId);
    if (!sourceArchetype) return;

    // Build changeset for removing this component
    const changeset = new ComponentChangeset();
    const componentId = getComponentIdFromRelationId(componentType);

    changeset.delete(componentType);

    // If removing a dontFragment relation, check if we should remove the wildcard marker
    if (componentId !== undefined && isDontFragmentComponent(componentId)) {
      const wildcardMarker = relation(componentId, "*");
      const entityData = sourceArchetype.getEntity(entityId);
      let hasOtherRelations = false;

      if (entityData) {
        for (const [otherComponentType] of entityData) {
          if (otherComponentType === componentType) continue;
          // Skip wildcard marker itself
          if (otherComponentType === wildcardMarker) continue;
          const otherComponentId = getComponentIdFromRelationId(otherComponentType);
          if (otherComponentId === componentId) {
            hasOtherRelations = true;
            break;
          }
        }
      }

      if (!hasOtherRelations) {
        changeset.delete(wildcardMarker);
      }
    }

    // Get removed component value before applying changeset
    const removedComponent = sourceArchetype.get(entityId, componentType);

    // Apply changeset using existing logic
    this.applyChangeset(entityId, sourceArchetype, changeset);

    // Remove from component reverse index
    this.untrackEntityReference(entityId, componentType, targetEntityId);

    // Trigger component removed hooks
    this.triggerLifecycleHooks(entityId, new Map(), new Map([[componentType, removedComponent]]));
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
      // Check if archetype-affecting components actually changed
      // (dontFragment components don't affect archetype signature)
      const currentRegularTypes = this.filterRegularComponentTypes(allCurrentComponentTypes);
      const finalRegularTypes = this.filterRegularComponentTypes(finalComponentTypes);
      const archetypeChanged = !this.areComponentTypesEqual(currentRegularTypes, finalRegularTypes);

      if (archetypeChanged) {
        // Move to new archetype (regular components changed)
        this.moveEntityToNewArchetype(entityId, currentArchetype, finalComponentTypes, changeset, removedComponents);
      } else {
        // Only dontFragment components changed, stay in same archetype
        this.updateEntityInSameArchetype(entityId, currentArchetype, changeset, removedComponents);
      }
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
    // Process dontFragment relation changes directly on World's storage
    this.applyDontFragmentChanges(entityId, changeset, removedComponents);

    // Direct update for regular components in archetype
    for (const [componentType, component] of changeset.adds) {
      if (isDontFragmentRelation(componentType)) {
        continue;
      }
      currentArchetype.set(entityId, componentType, component);
    }
  }

  /**
   * Apply dontFragment relation changes directly to World's storage
   * This is much more efficient than the removeEntity + addEntity approach
   */
  private applyDontFragmentChanges(
    entityId: EntityId,
    changeset: ComponentChangeset,
    removedComponents: Map<EntityId<any>, any>,
  ): void {
    // Get or create the entity's dontFragment relations map
    let entityRelations = this.dontFragmentRelations.get(entityId);

    for (const componentType of changeset.removes) {
      if (isDontFragmentRelation(componentType)) {
        if (entityRelations) {
          const removedValue = entityRelations.get(componentType);
          if (removedValue !== undefined || entityRelations.has(componentType)) {
            removedComponents.set(componentType, removedValue);
            entityRelations.delete(componentType);
          }
        }
      }
    }

    for (const [componentType, component] of changeset.adds) {
      if (isDontFragmentRelation(componentType)) {
        if (!entityRelations) {
          entityRelations = new Map();
          this.dontFragmentRelations.set(entityId, entityRelations);
        }
        entityRelations.set(componentType, component);
      }
    }

    // Clean up empty map
    if (entityRelations && entityRelations.size === 0) {
      this.dontFragmentRelations.delete(entityId);
    }
  }

  /**
   * Update entity reference tracking based on changeset
   */
  private updateEntityReferences(entityId: EntityId, changeset: ComponentChangeset): void {
    // Remove references for removed components
    for (const componentType of changeset.removes) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        this.untrackEntityReference(entityId, componentType, targetId);
      } else if (componentType >= 1024) {
        // Entity used as component type
        this.untrackEntityReference(entityId, componentType, componentType);
      }
    }

    // Add references for added components
    for (const [componentType] of changeset.adds) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        this.trackEntityReference(entityId, componentType, targetId);
      } else if (componentType >= 1024) {
        // Entity used as component type
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
   * Compare two arrays of component types for equality (order-independent)
   */
  private areComponentTypesEqual(types1: EntityId<any>[], types2: EntityId<any>[]): boolean {
    if (types1.length !== types2.length) return false;
    const sorted1 = [...types1].sort((a, b) => a - b);
    const sorted2 = [...types2].sort((a, b) => a - b);
    return sorted1.every((v, i) => v === sorted2[i]);
  }

  /**
   * Filter out dontFragment relations from component types, but keep wildcard markers
   */
  private filterRegularComponentTypes(componentTypes: Iterable<EntityId<any>>): EntityId<any>[] {
    const regularTypes: EntityId<any>[] = [];

    for (const componentType of componentTypes) {
      // Keep wildcard markers for dontFragment components (they mark the archetype)
      if (isDontFragmentWildcard(componentType)) {
        regularTypes.push(componentType);
        continue;
      }

      // Skip specific dontFragment relations from archetype signature
      if (isDontFragmentRelation(componentType)) {
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
   * Check if an archetype's signature references a specific entity
   * (via entity-relation targeting the entity, or using entity as component type)
   */
  private archetypeReferencesEntity(archetype: Archetype, entityId: EntityId): boolean {
    for (const componentType of archetype.componentTypes) {
      if (componentType === entityId) {
        return true;
      }
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType);
        if (targetId === entityId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Cleanup empty archetypes that reference a specific deleted entity
   * Only removes archetypes whose component types reference the entity
   */
  private cleanupArchetypesReferencingEntity(entityId: EntityId): void {
    for (let i = this.archetypes.length - 1; i >= 0; i--) {
      const archetype = this.archetypes[i]!;
      if (archetype.getEntities().length === 0 && this.archetypeReferencesEntity(archetype, entityId)) {
        this.removeArchetypeFromList(archetype);
        this.removeArchetypeFromSignatureMap(archetype);
        this.removeArchetypeFromComponentIndex(archetype);
        this.removeArchetypeFromQueries(archetype);
      }
    }
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

      const componentId = getComponentIdFromRelationId(componentType);
      if (componentId !== undefined) {
        const wildcardRelationId = relation(componentId, "*");
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

      const componentId = getComponentIdFromRelationId(componentType);
      if (componentId !== undefined) {
        const wildcardRelationId = relation(componentId, "*");
        const wildcardHooks = this.hooks.get(wildcardRelationId);
        if (wildcardHooks) {
          for (const hook of wildcardHooks) {
            hook.on_remove?.(entityId, componentType, component);
          }
        }
      }
    }

    // Trigger multi-component hooks
    this.triggerMultiComponentHooks(entityId, addedComponents, removedComponents);
  }

  /**
   * Trigger multi-component hooks based on changes
   */
  private triggerMultiComponentHooks(
    entityId: EntityId,
    addedComponents: Map<EntityId<any>, any>,
    removedComponents: Map<EntityId<any>, any>,
  ): void {
    for (const entry of this.multiHooks) {
      const { componentTypes, requiredComponents, hook } = entry;

      // Check if any of the required components were added
      let anyRequiredAdded = false;
      for (const reqComp of requiredComponents) {
        if (addedComponents.has(reqComp)) {
          anyRequiredAdded = true;
          break;
        }
      }

      // Check if any of the required components were removed
      let anyRequiredRemoved = false;
      for (const reqComp of requiredComponents) {
        if (removedComponents.has(reqComp)) {
          anyRequiredRemoved = true;
          break;
        }
      }

      // Handle on_set: trigger if any required component was added and entity has all required components now
      if (anyRequiredAdded && hook.on_set) {
        const hasAllRequired = this.entityHasAllComponents(entityId, requiredComponents);
        if (hasAllRequired) {
          const components = this.collectMultiHookComponents(entityId, componentTypes);
          hook.on_set(entityId, componentTypes, components);
        }
      }

      // Handle on_remove: trigger if any required component was removed and entity had all required components before removal
      if (anyRequiredRemoved && hook.on_remove) {
        // Check if entity had all required components before removal
        const hadAllRequiredBefore = this.entityHadAllComponentsBefore(entityId, requiredComponents, removedComponents);
        if (hadAllRequiredBefore) {
          // Collect components snapshot from before removal
          const components = this.collectMultiHookComponentsWithRemoved(entityId, componentTypes, removedComponents);
          hook.on_remove(entityId, componentTypes, components);
        }
      }
    }
  }

  /**
   * Check if entity currently has all required components
   */
  private entityHasAllComponents(entityId: EntityId, requiredComponents: EntityId<any>[]): boolean {
    for (const reqComp of requiredComponents) {
      if (!this.has(entityId, reqComp)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if entity had all required components before removal
   */
  private entityHadAllComponentsBefore(
    entityId: EntityId,
    requiredComponents: EntityId<any>[],
    removedComponents: Map<EntityId<any>, any>,
  ): boolean {
    for (const reqComp of requiredComponents) {
      // Component was either present before (and now removed) or still present
      const wasRemoved = removedComponents.has(reqComp);
      const stillHas = this.has(entityId, reqComp);
      if (!wasRemoved && !stillHas) {
        return false;
      }
    }
    return true;
  }

  /**
   * Collect component values for multi-component hook (current state)
   */
  private collectMultiHookComponents(entityId: EntityId, componentTypes: readonly ComponentType<any>[]): any[] {
    const result: any[] = [];
    for (const ct of componentTypes) {
      if (isOptionalEntityId(ct)) {
        const optionalId = ct.optional;
        result.push(this.getOptional(entityId, optionalId));
      } else {
        result.push(this.get(entityId, ct as EntityId<any>));
      }
    }
    return result;
  }

  /**
   * Collect component values for multi-component hook with removed components (snapshot before removal)
   */
  private collectMultiHookComponentsWithRemoved(
    entityId: EntityId,
    componentTypes: readonly ComponentType<any>[],
    removedComponents: Map<EntityId<any>, any>,
  ): any[] {
    const result: any[] = [];
    for (const ct of componentTypes) {
      if (isOptionalEntityId(ct)) {
        const optionalId = ct.optional;
        if (removedComponents.has(optionalId)) {
          result.push({ value: removedComponents.get(optionalId) });
        } else {
          result.push(this.getOptional(entityId, optionalId));
        }
      } else {
        const compId = ct as EntityId<any>;
        if (removedComponents.has(compId)) {
          result.push(removedComponents.get(compId));
        } else {
          result.push(this.get(entityId, compId));
        }
      }
    }
    return result;
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
          id: encodeEntityId(entity),
          components: Array.from(components.entries()).map(([rawType, value]) => ({
            type: encodeEntityId(rawType),
            value: value === MISSING_COMPONENT ? undefined : value,
          })),
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
