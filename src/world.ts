import { Archetype } from "./archetype";
import { CommandBuffer, type Command } from "./command-buffer";
import type { EntityId } from "./entity";
import { EntityIdManager, getDetailedIdType } from "./entity";
import { Query } from "./query";
import type { QueryFilter } from "./query-filter";
import type { ComponentTuple } from "./types";
import type { System } from "./system";
import { getOrCreateWithSideEffect } from "./utils";

/**
 * Hook types for component lifecycle events
 */
export interface ComponentLifecycleHook<T> {
  /**
   * Called when a component is added to an entity
   */
  onAdded?: (entityId: EntityId, componentType: EntityId<T>, component: T) => void;
  /**
   * Called when a component is removed from an entity
   */
  onRemoved?: (entityId: EntityId, componentType: EntityId<T>) => void;
}

/**
 * World class for ECS architecture
 * Manages entities, components, and systems
 */
export class World<ExtraParams extends any[] = [deltaTime: number]> {
  private entityIdManager = new EntityIdManager();
  private archetypes: Archetype[] = [];
  private archetypeMap = new Map<string, Archetype>();
  private entityToArchetype = new Map<EntityId, Archetype>();
  private systems: System<ExtraParams>[] = [];
  private queries: Query[] = [];
  private commandBuffer: CommandBuffer;
  private componentToArchetypes = new Map<EntityId<any>, Archetype[]>();

  /**
   * Hook storage for component lifecycle events
   */
  private componentLifecycleHooks = new Map<EntityId<any>, Set<ComponentLifecycleHook<any>>>();

  /**
   * Reverse index tracking which entities use each entity as a component type
   * Maps entity ID to set of {sourceEntityId, componentType} pairs where componentType uses this entity
   * This includes both relation components and direct usage of entities as component types
   */
  private entityReverseIndex = new Map<EntityId, Set<{ sourceEntityId: EntityId; componentType: EntityId }>>();

  constructor() {
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
  createEntity(): EntityId {
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
      if (sourceArchetype && sourceArchetype.componentTypes.includes(componentType)) {
        // Remove from current archetype and move to new archetype without this component
        const currentComponents = new Map<EntityId<any>, any>();
        for (const compType of sourceArchetype.componentTypes) {
          if (compType !== componentType) {
            const data = sourceArchetype.getComponent(sourceEntityId, compType);
            if (data !== undefined) {
              currentComponents.set(compType, data);
            }
          }
        }

        const newComponentTypes = Array.from(currentComponents.keys()).sort((a, b) => a - b);
        const newArchetype = this.getOrCreateArchetype(newComponentTypes);

        // Remove from current archetype
        sourceArchetype.removeEntity(sourceEntityId);

        // Add to new archetype
        newArchetype.addEntity(sourceEntityId, currentComponents);
        this.entityToArchetype.set(sourceEntityId, newArchetype);

        // Remove from component reverse index
        this.removeComponentReference(sourceEntityId, componentType, entityId);
      }
    }

    // Clean up the reverse index for this entity
    this.entityReverseIndex.delete(entityId);

    archetype.removeEntity(entityId);
    this.entityToArchetype.delete(entityId);
    this.entityIdManager.deallocate(entityId);
  }

  /**
   * Check if an entity exists
   */
  hasEntity(entityId: EntityId): boolean {
    return this.entityToArchetype.has(entityId);
  }

  /**
   * Add a component to an entity (deferred)
   */
  addComponent<T>(entityId: EntityId, componentType: EntityId<T>, component: T): void {
    if (!this.hasEntity(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }
    this.commandBuffer.addComponent(entityId, componentType, component);
  }

  /**
   * Remove a component from an entity (deferred)
   */
  removeComponent<T>(entityId: EntityId, componentType: EntityId<T>): void {
    if (!this.hasEntity(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }
    this.commandBuffer.removeComponent(entityId, componentType);
  }

  /**
   * Destroy an entity and remove all its components (deferred)
   */
  destroyEntity(entityId: EntityId): void {
    this.commandBuffer.destroyEntity(entityId);
  }

  /**
   * Check if an entity has a specific component
   */
  hasComponent<T>(entityId: EntityId, componentType: EntityId<T>): boolean {
    const archetype = this.entityToArchetype.get(entityId);
    return archetype ? archetype.componentTypes.includes(componentType) : false;
  }

  /**
   * Get a component from an entity
   */
  getComponent<T>(entityId: EntityId, componentType: EntityId<T>): T | undefined {
    const archetype = this.entityToArchetype.get(entityId);
    return archetype ? archetype.getComponent(entityId, componentType) : undefined;
  }

  /**
   * Register a system
   */
  registerSystem(system: System<ExtraParams>): void {
    this.systems.push(system);
  }

  /**
   * Unregister a system
   */
  unregisterSystem(system: System<ExtraParams>): void {
    const index = this.systems.indexOf(system);
    if (index !== -1) {
      this.systems.splice(index, 1);
    }
  }

  /**
   * Register a lifecycle hook for component events
   */
  registerComponentLifecycleHook<T>(componentType: EntityId<T>, hook: ComponentLifecycleHook<T>): void {
    if (!this.componentLifecycleHooks.has(componentType)) {
      this.componentLifecycleHooks.set(componentType, new Set());
    }
    this.componentLifecycleHooks.get(componentType)!.add(hook);
  }

  /**
   * Unregister a lifecycle hook for component events
   */
  unregisterComponentLifecycleHook<T>(componentType: EntityId<T>, hook: ComponentLifecycleHook<T>): void {
    const hooks = this.componentLifecycleHooks.get(componentType);
    if (hooks) {
      hooks.delete(hook);
      if (hooks.size === 0) {
        this.componentLifecycleHooks.delete(componentType);
      }
    }
  }

  /**
   * Update the world (run all systems)
   */
  update(...params: ExtraParams): void {
    for (const system of this.systems) {
      system.update(this, ...params);
    }
    this.commandBuffer.execute();
  }

  /**
   * Execute all deferred commands immediately without running systems
   */
  flushCommands(): void {
    this.commandBuffer.execute();
  }

  /**
   * Create a cached query for efficient entity lookups
   */
  createQuery(componentTypes: EntityId<any>[], filter: QueryFilter = {}): Query {
    return new Query(this, componentTypes, filter);
  }

  /**
   * @internal Register a query for archetype update notifications
   */
  registerQuery(query: Query): void {
    this.queries.push(query);
  }

  /**
   * @internal Unregister a query
   */
  unregisterQuery(query: Query): void {
    const index = this.queries.indexOf(query);
    if (index !== -1) {
      this.queries.splice(index, 1);
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
    includeComponents: true
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }>;
  queryEntities(
    componentTypes: EntityId<any>[],
    includeComponents?: boolean
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
  executeEntityCommands(entityId: EntityId, commands: Command[]): void {
    // Check if entity should be destroyed
    const hasDestroy = commands.some((cmd) => cmd.type === "destroyEntity");
    if (hasDestroy) {
      this._destroyEntity(entityId);
      return;
    }

    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) {
      return; // Entity doesn't exist, nothing to do
    }

    // Get current component data
    const currentComponents = new Map<EntityId<any>, any>();
    for (const componentType of currentArchetype.componentTypes) {
      const data = currentArchetype.getComponent(entityId, componentType);
      if (data !== undefined) {
        currentComponents.set(componentType, data);
      }
    }

    // Track component changes using Map and Set for better performance
    const adds = new Map<EntityId<any>, any>();
    const removes = new Set<EntityId<any>>();

    // Process commands to determine final state
    for (const cmd of commands) {
      switch (cmd.type) {
        case "addComponent":
          if (cmd.componentType && cmd.component !== undefined) {
            adds.set(cmd.componentType, cmd.component);
            removes.delete(cmd.componentType); // Remove from removes if it was going to be removed
          }
          break;
        case "removeComponent":
          if (cmd.componentType) {
            removes.add(cmd.componentType);
            adds.delete(cmd.componentType); // Remove from adds if it was going to be added
          }
          break;
      }
    }

    // Apply changes to current components to get final state
    const finalComponents = new Map(currentComponents);

    // Apply removals
    for (const componentType of removes) {
      finalComponents.delete(componentType);
    }

    // Apply additions/updates
    for (const [componentType, component] of adds) {
      finalComponents.set(componentType, component);
    }

    // Calculate final component types
    const finalComponentTypes = Array.from(finalComponents.keys()).sort((a, b) => a - b);

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
      for (const [componentType, component] of adds) {
        currentArchetype.setComponent(entityId, componentType, component);
      }
      // Removals are already handled by not including them in finalComponents
    }

    // Update component reverse index for removed components
    for (const componentType of removes) {
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
    for (const [componentType, component] of adds) {
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

    // Trigger component added hooks
    for (const [componentType, component] of adds) {
      const hooks = this.componentLifecycleHooks.get(componentType);
      if (hooks) {
        for (const hook of hooks) {
          if (hook.onAdded) {
            hook.onAdded(entityId, componentType, component);
          }
        }
      }
    }

    // Trigger component removed hooks
    for (const componentType of removes) {
      const hooks = this.componentLifecycleHooks.get(componentType);
      if (hooks) {
        for (const hook of hooks) {
          if (hook.onRemoved) {
            hook.onRemoved(entityId, componentType);
          }
        }
      }
    }
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
    targetEntityId: EntityId
  ): Array<{ sourceEntityId: EntityId; componentType: EntityId }> {
    const references = this.entityReverseIndex.get(targetEntityId);
    return references ? Array.from(references) : [];
  }
}
