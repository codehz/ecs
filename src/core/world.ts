import { ComponentChangeset } from "../commands/changeset";
import { CommandBuffer, type Command } from "../commands/command-buffer";
import { serializeQueryFilter, type QueryFilter } from "../query/filter";
import { Query } from "../query/query";
import { getOrCreateWithSideEffect } from "../utils/utils";
import { Archetype, MISSING_COMPONENT } from "./archetype";
import { EntityBuilder } from "./builder";
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
import type { SerializedComponent, SerializedEntity, SerializedWorld } from "./serialization";
import { decodeSerializedId, encodeEntityId } from "./serialization";
import type {
  ComponentTuple,
  ComponentType,
  LegacyLifecycleCallback,
  LegacyLifecycleHook,
  LifecycleCallback,
  LifecycleHook,
  LifecycleHookEntry,
} from "./types";
import { isOptionalEntityId } from "./types";
import {
  applyChangeset,
  filterRegularComponentTypes,
  maybeRemoveWildcardMarker,
  processCommands,
  removeMatchingRelations,
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
  private dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>> = new Map();
  private componentEntityComponents: Map<EntityId, Map<EntityId<any>, any>> = new Map();
  private relationEntityIdsByTarget: Map<EntityId, Set<EntityId>> = new Map();

  // Query management
  private queries: Query[] = [];
  private queryCache = new Map<string, { query: Query; refCount: number }>();

  // Command execution
  private commandBuffer = new CommandBuffer((entityId, commands) => this.executeEntityCommands(entityId, commands));

  // Lifecycle hooks
  private legacyHooks = new Map<EntityId<any>, Set<LegacyLifecycleHook<any>>>();
  private hooks: Set<LifecycleHookEntry> = new Set();

  constructor(snapshot?: SerializedWorld) {
    if (snapshot && typeof snapshot === "object") {
      this.deserializeSnapshot(snapshot);
    }
  }

  private deserializeSnapshot(snapshot: SerializedWorld): void {
    if (snapshot.entityManager) {
      this.entityIdManager.deserializeState(snapshot.entityManager);
    }

    if (Array.isArray(snapshot.componentEntities)) {
      for (const entry of snapshot.componentEntities) {
        const entityId = decodeSerializedId(entry.id);
        if (!this.isComponentEntityId(entityId)) continue;

        const componentsArray: SerializedComponent[] = entry.components || [];
        const componentMap = new Map<EntityId<any>, any>();

        for (const componentEntry of componentsArray) {
          const componentType = decodeSerializedId(componentEntry.type);
          componentMap.set(componentType, componentEntry.value);
        }

        this.componentEntityComponents.set(entityId, componentMap);
        this.registerRelationEntityId(entityId);
      }
    }

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

        for (const compType of componentTypes) {
          const detailedType = getDetailedIdType(compType);
          if (detailedType.type === "entity-relation") {
            trackEntityReference(this.entityReferences, entityId, compType, detailedType.targetId!);
          } else if (detailedType.type === "entity") {
            trackEntityReference(this.entityReferences, entityId, compType, compType);
          }
        }
      }
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

  private isComponentEntityId(entityId: EntityId): boolean {
    const detailed = getDetailedIdType(entityId);
    return detailed.type !== "entity" && detailed.type !== "invalid";
  }

  private registerRelationEntityId(entityId: EntityId): void {
    const detailed = getDetailedIdType(entityId);
    if (detailed.type !== "entity-relation") return;

    const targetId = detailed.targetId;
    if (targetId === undefined) return;

    const existing = this.relationEntityIdsByTarget.get(targetId);
    if (existing) {
      existing.add(entityId);
      return;
    }

    this.relationEntityIdsByTarget.set(targetId, new Set([entityId]));
  }

  private unregisterRelationEntityId(entityId: EntityId): void {
    const detailed = getDetailedIdType(entityId);
    if (detailed.type !== "entity-relation") return;

    const targetId = detailed.targetId;
    if (targetId === undefined) return;

    const existing = this.relationEntityIdsByTarget.get(targetId);
    if (!existing) return;

    existing.delete(entityId);
    if (existing.size === 0) {
      this.relationEntityIdsByTarget.delete(targetId);
    }
  }

  private getComponentEntityComponents(entityId: EntityId, create: boolean): Map<EntityId<any>, any> | undefined {
    let data = this.componentEntityComponents.get(entityId);
    if (!data && create) {
      data = new Map();
      this.componentEntityComponents.set(entityId, data);
      this.registerRelationEntityId(entityId);
    }
    return data;
  }

  private clearComponentEntityComponents(entityId: EntityId): void {
    if (this.componentEntityComponents.delete(entityId)) {
      this.unregisterRelationEntityId(entityId);
    }
  }

  private cleanupComponentEntitiesReferencingEntity(targetId: EntityId): void {
    const relationEntities = this.relationEntityIdsByTarget.get(targetId);
    if (!relationEntities) return;

    for (const relationEntityId of relationEntities) {
      this.componentEntityComponents.delete(relationEntityId);
    }
    this.relationEntityIdsByTarget.delete(targetId);
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
      triggerRemoveHooksForEntityDeletion(this.createHooksContext(), cur, removedComponents, archetype);

      this.cleanupArchetypesReferencingEntity(cur);
      this.entityIdManager.deallocate(cur);
      this.cleanupComponentEntitiesReferencingEntity(cur);
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
    if (this.isComponentEntityId(entityId)) return true;
    return this.entityToArchetype.has(entityId);
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
    // Handle singleton component overload: set(componentId, data)
    if (maybeComponent === undefined && componentTypeOrComponent !== undefined) {
      const detailedType = getDetailedIdType(entityId);
      // Check if this looks like a singleton call (2 arguments, second is not an EntityId)
      if (detailedType.type === "component" || detailedType.type === "component-relation") {
        // Singleton component: set(componentId, data)
        const componentId = entityId as ComponentId;
        const component = componentTypeOrComponent;
        if (!this.exists(componentId)) {
          throw new Error(`Component entity ${componentId} does not exist`);
        }
        const detailedComponentType = getDetailedIdType(componentId);
        if (detailedComponentType.type === "invalid") {
          throw new Error(`Invalid component type: ${componentId}`);
        }
        if (detailedComponentType.type === "wildcard-relation") {
          throw new Error(`Cannot directly add wildcard relation components: ${componentId}`);
        }
        this.commandBuffer.set(componentId, componentId, component);
        return;
      }
    }

    // Standard overload: set(entityId, componentType, data?) or set(entityId, componentType)
    const entityIdArg = entityId as EntityId;
    const componentType = componentTypeOrComponent as EntityId;
    const component = maybeComponent;

    if (!this.exists(entityIdArg)) {
      throw new Error(`Entity ${entityIdArg} does not exist`);
    }

    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }
    if (detailedType.type === "wildcard-relation") {
      throw new Error(`Cannot directly add wildcard relation components: ${componentType}`);
    }

    this.commandBuffer.set(entityIdArg, componentType, component);
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
    // Handle singleton component overload: remove(componentId)
    if (componentType === undefined) {
      const componentId = entityId as ComponentId<T>;
      if (!this.exists(componentId)) {
        throw new Error(`Component entity ${componentId} does not exist`);
      }
      this.commandBuffer.remove(componentId, componentId);
      return;
    }

    const entityIdArg = entityId as EntityId;
    if (!this.exists(entityIdArg)) {
      throw new Error(`Entity ${entityIdArg} does not exist`);
    }

    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }

    this.commandBuffer.remove(entityIdArg, componentType);
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
      return this.componentEntityComponents.get(componentId)?.has(componentId) ?? false;
    }

    if (this.isComponentEntityId(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId === undefined) return false;

        const data = this.componentEntityComponents.get(entityId);
        if (!data) return false;

        for (const key of data.keys()) {
          if (getComponentIdFromRelationId(key) === componentId) return true;
        }
        return false;
      }

      return this.componentEntityComponents.get(entityId)?.has(componentType) ?? false;
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) return false;

    if (archetype.componentTypeSet.has(componentType)) return true;

    if (isDontFragmentRelation(componentType)) {
      return this.dontFragmentRelations.get(entityId)?.has(componentType) ?? false;
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
    if (this.isComponentEntityId(entityId)) {
      if (isWildcardRelationId(componentType as EntityId<any>)) {
        const componentId = getComponentIdFromRelationId(componentType as EntityId<any>);
        const data = this.componentEntityComponents.get(entityId);
        const relations: [EntityId<unknown>, any][] = [];

        if (componentId !== undefined && data) {
          for (const [key, value] of data.entries()) {
            if (getComponentIdFromRelationId(key) === componentId) {
              const detailed = getDetailedIdType(key);
              if (detailed.type === "entity-relation" || detailed.type === "component-relation") {
                relations.push([detailed.targetId!, value]);
              }
            }
          }
        }

        return relations;
      }

      const data = this.componentEntityComponents.get(entityId);
      if (!data || !data.has(componentType as EntityId<any>)) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
      return data.get(componentType as EntityId<any>);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (componentType >= 0 || componentType % RELATION_SHIFT !== 0) {
      const inArchetype = archetype.componentTypeSet.has(componentType);
      const hasDontFragment = isDontFragmentRelation(componentType);
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
    if (this.isComponentEntityId(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId === undefined) return undefined;

        const data = this.componentEntityComponents.get(entityId);
        if (!data) return undefined;

        const relations: [EntityId<unknown>, any][] = [];
        for (const [key, value] of data.entries()) {
          if (getComponentIdFromRelationId(key) === componentId) {
            const detailed = getDetailedIdType(key);
            if (detailed.type === "entity-relation" || detailed.type === "component-relation") {
              relations.push([detailed.targetId!, value]);
            }
          }
        }

        if (relations.length === 0) return undefined;
        return { value: relations as T };
      }

      const data = this.componentEntityComponents.get(entityId);
      if (!data || !data.has(componentType)) return undefined;
      return { value: data.get(componentType) };
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
   *
   * @deprecated For single components, use the array overload with LifecycleCallback for better multi-component support
   *
   * @overload hook<T>(componentType: EntityId<T>, hook: LegacyLifecycleHook<T> | LegacyLifecycleCallback<T>): () => void
   * Registers a hook for a single component type (legacy API).
   *
   * @overload hook<const T extends readonly ComponentType<any>[]>(
   *   componentTypes: T,
   *   hook: LifecycleHook<T> | LifecycleCallback<T>,
   * ): () => void
   * Registers a hook for multiple component types.
   * The hook is triggered when all required components change together.
   *
   * @param componentTypesOrSingle - A single component type or an array of component types
   * @param hook - Either a hook object with on_init/on_set/on_remove handlers, or a callback function
   * @returns A function that unsubscribes the hook when called
   *
   * @throws {Error} If no required components are specified in array overload
   *
   * @example
   * // Array overload (recommended)
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
   */
  hook<T>(componentType: EntityId<T>, hook: LegacyLifecycleHook<T> | LegacyLifecycleCallback<T>): () => void;
  hook<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    hook: LifecycleHook<T> | LifecycleCallback<T>,
  ): () => void;
  hook(
    componentTypesOrSingle: EntityId<any> | readonly ComponentType<any>[],
    hook: LegacyLifecycleHook<any> | LifecycleHook<any> | LegacyLifecycleCallback<any> | LifecycleCallback<any>,
  ): () => void {
    // Normalize callback functions to hook objects
    if (typeof hook === "function") {
      if (Array.isArray(componentTypesOrSingle)) {
        const callback = hook as LifecycleCallback<any>;
        hook = {
          on_init: (entityId, ...components) => callback("init", entityId, ...components),
          on_set: (entityId, ...components) => callback("set", entityId, ...components),
          on_remove: (entityId, ...components) => callback("remove", entityId, ...components),
        } as LifecycleHook<any>;
      } else {
        const callback = hook as LegacyLifecycleCallback<any>;
        hook = {
          on_init: (entityId, componentType, component) => callback("init", entityId, componentType, component),
          on_set: (entityId, componentType, component) => callback("set", entityId, componentType, component),
          on_remove: (entityId, componentType, component) => callback("remove", entityId, componentType, component),
        } as LegacyLifecycleHook<any>;
      }
    }

    if (Array.isArray(componentTypesOrSingle)) {
      const componentTypes = componentTypesOrSingle as readonly ComponentType<any>[];
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
        hook: hook as LifecycleHook<any>,
      };
      this.hooks.add(entry);

      // Add to archetypes
      for (const archetype of this.archetypes) {
        if (this.archetypeMatchesHook(archetype, entry)) {
          archetype.matchingMultiHooks.add(entry);
        }
      }

      const multiHook = hook as LifecycleHook<any>;
      if (multiHook.on_init !== undefined) {
        const matchingArchetypes = this.getMatchingArchetypes(requiredComponents);
        for (const archetype of matchingArchetypes) {
          for (const entityId of archetype.getEntities()) {
            const components = collectMultiHookComponents(this.createHooksContext(), entityId, componentTypes);
            multiHook.on_init(entityId, ...components);
          }
        }
      }

      return () => {
        this.hooks.delete(entry);
        for (const archetype of this.archetypes) {
          archetype.matchingMultiHooks.delete(entry);
        }
      };
    } else {
      const componentType = componentTypesOrSingle as EntityId<any>;
      if (!this.legacyHooks.has(componentType)) {
        this.legacyHooks.set(componentType, new Set());
      }
      const legacyHook = hook as LegacyLifecycleHook<any>;
      this.legacyHooks.get(componentType)!.add(legacyHook);

      if (legacyHook.on_init !== undefined) {
        this.archetypesByComponent.get(componentType)?.forEach((archetype) => {
          const entities = archetype.getEntityToIndexMap();
          const componentData = archetype.getComponentData<any>(componentType);
          for (const [entity, index] of entities) {
            const data = componentData[index];
            const value = data === MISSING_COMPONENT ? undefined : data;
            legacyHook.on_init?.(entity, componentType, value);
          }
        });
      }

      return () => {
        const hooks = this.legacyHooks.get(componentType);
        if (hooks) {
          hooks.delete(legacyHook);
          if (hooks.size === 0) {
            this.legacyHooks.delete(componentType);
          }
        }
      };
    }
  }

  /** @deprecated use the unsubscribe function returned by hook() instead */
  unhook<T>(componentType: EntityId<T>, hook: LegacyLifecycleHook<T>): void;
  /** @deprecated use the unsubscribe function returned by hook() instead */
  unhook<const T extends readonly ComponentType<any>[]>(componentTypes: T, hook: LifecycleHook<T>): void;
  /** @deprecated use the unsubscribe function returned by hook() instead */
  unhook(
    componentTypesOrSingle: EntityId<any> | readonly ComponentType<any>[],
    hook: LegacyLifecycleHook<any> | LifecycleHook<any>,
  ): void {
    // Note: Callback functions passed to hook() are converted to hook objects internally,
    // so unhook() only accepts the original hook object references.
    if (Array.isArray(componentTypesOrSingle)) {
      for (const entry of this.hooks) {
        if (entry.hook === hook) {
          this.hooks.delete(entry);
          for (const archetype of this.archetypes) {
            archetype.matchingMultiHooks.delete(entry);
          }
          break;
        }
      }
    } else {
      const componentType = componentTypesOrSingle as EntityId<any>;
      const hooks = this.legacyHooks.get(componentType);
      if (hooks) {
        hooks.delete(hook as LegacyLifecycleHook<any>);
        if (hooks.size === 0) {
          this.legacyHooks.delete(componentType);
        }
      }
    }
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
    const sortedTypes = [...componentTypes].sort((a, b) => a - b);
    const filterKey = serializeQueryFilter(filter);
    const key = `${this.createArchetypeSignature(sortedTypes)}${filterKey ? `|${filterKey}` : ""}`;

    const cached = this.queryCache.get(key);
    if (cached) {
      cached.refCount++;
      return cached.query;
    }

    const query = new Query(this, sortedTypes, filter);
    query._cacheKey = key;
    this.queryCache.set(key, { query, refCount: 1 });
    return query;
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
    this.queries.push(query);
  }

  _unregisterQuery(query: Query): void {
    const index = this.queries.indexOf(query);
    if (index !== -1) {
      this.queries.splice(index, 1);
    }
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
    const key = query._cacheKey;
    if (!key) return;

    const cached = this.queryCache.get(key);
    if (!cached || cached.query !== query) return;

    cached.refCount--;
    if (cached.refCount <= 0) {
      this.queryCache.delete(key);
      this._unregisterQuery(query);
      cached.query._disposeInternal();
    }
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

    // Use Set-based intersection starting from the shortest list
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
        result.push(...archetype.getEntitiesWithComponents(componentTypes as EntityId<any>[]));
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

  executeEntityCommands(entityId: EntityId, commands: Command[]): ComponentChangeset {
    const changeset = new ComponentChangeset();

    if (this.isComponentEntityId(entityId)) {
      this.executeComponentEntityCommands(entityId, commands);
      return changeset;
    }

    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.destroyEntityImmediate(entityId);
      return changeset;
    }

    const currentArchetype = this.entityToArchetype.get(entityId);
    if (!currentArchetype) return changeset;

    processCommands(entityId, currentArchetype, commands, changeset, (eid, arch, compId) => {
      if (isExclusiveComponent(compId)) {
        removeMatchingRelations(eid, arch, compId, changeset);
      }
    });

    const { removedComponents, newArchetype } = applyChangeset(
      { dontFragmentRelations: this.dontFragmentRelations, ensureArchetype: (ct) => this.ensureArchetype(ct) },
      entityId,
      currentArchetype,
      changeset,
      this.entityToArchetype,
    );

    this.updateEntityReferences(entityId, changeset);
    triggerLifecycleHooks(
      this.createHooksContext(),
      entityId,
      changeset.adds,
      removedComponents,
      currentArchetype,
      newArchetype,
    );

    return changeset;
  }

  private executeComponentEntityCommands(entityId: EntityId, commands: Command[]): void {
    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.clearComponentEntityComponents(entityId);
      return;
    }

    for (const command of commands) {
      if (command.type === "set" && command.componentType) {
        const data = this.getComponentEntityComponents(entityId, true)!;
        data.set(command.componentType, command.component);
      } else if (command.type === "delete" && command.componentType) {
        const data = this.componentEntityComponents.get(entityId);
        if (!data) continue;

        if (isWildcardRelationId(command.componentType)) {
          const componentId = getComponentIdFromRelationId(command.componentType);
          if (componentId !== undefined) {
            for (const key of Array.from(data.keys())) {
              if (getComponentIdFromRelationId(key) === componentId) {
                data.delete(key);
              }
            }
          }
        } else {
          data.delete(command.componentType);
        }

        if (data.size === 0) {
          this.clearComponentEntityComponents(entityId);
        }
      }
    }
  }

  private createHooksContext(): HooksContext {
    return {
      hooks: this.legacyHooks,
      multiHooks: this.hooks,
      has: (eid, ct) => this.has(eid, ct),
      get: (eid, ct) => this.get(eid, ct),
      getOptional: (eid, ct) => this.getOptional(eid, ct),
    };
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
      { dontFragmentRelations: this.dontFragmentRelations, ensureArchetype: (ct) => this.ensureArchetype(ct) },
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
    const sortedTypes = regularTypes.sort((a, b) => a - b);
    const hashKey = this.createArchetypeSignature(sortedTypes);

    return getOrCreateWithSideEffect(this.archetypeBySignature, hashKey, () => this.createNewArchetype(sortedTypes));
  }

  private createNewArchetype(componentTypes: EntityId<any>[]): Archetype {
    const newArchetype = new Archetype(componentTypes, this.dontFragmentRelations);
    this.archetypes.push(newArchetype);

    for (const componentType of componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType) || [];
      archetypes.push(newArchetype);
      this.archetypesByComponent.set(componentType, archetypes);
    }

    for (const query of this.queries) {
      query.checkNewArchetype(newArchetype);
    }

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
    return entry.requiredComponents.every((c: EntityId<any>) => {
      if (isWildcardRelationId(c)) {
        if (isDontFragmentWildcard(c)) return true;
        const componentId = getComponentIdFromRelationId(c);
        return componentId !== undefined && archetype.hasRelationWithComponentId(componentId);
      }
      return archetype.componentTypeSet.has(c) || isDontFragmentRelation(c);
    });
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

    for (const query of this.queries) {
      query.removeArchetype(archetype);
    }
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

    const componentEntities: SerializedEntity[] = [];
    for (const [entityId, components] of this.componentEntityComponents.entries()) {
      componentEntities.push({
        id: encodeEntityId(entityId),
        components: Array.from(components.entries()).map(([rawType, value]) => ({
          type: encodeEntityId(rawType),
          value: value === MISSING_COMPONENT ? undefined : value,
        })),
      });
    }

    return {
      version: 1,
      entityManager: this.entityIdManager.serializeState(),
      entities,
      componentEntities,
    };
  }
}
