import { ComponentChangeset } from "../commands/changeset";
import { CommandBuffer, type Command } from "../commands/command-buffer";
import { serializeQueryFilter, type QueryFilter } from "../query/filter";
import { Query } from "../query/query";
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
import { collectMultiHookComponents, triggerLifecycleHooks, type HooksContext } from "./world-hooks";
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

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const archetype = this.entityToArchetype.get(cur);
      if (!archetype) continue;

      const componentReferences = Array.from(getEntityReferences(this.entityReferences, cur));
      for (const [sourceEntityId, componentType] of componentReferences) {
        const sourceArchetype = this.entityToArchetype.get(sourceEntityId);
        if (!sourceArchetype) continue;

        if (isCascadeDeleteRelation(componentType)) {
          if (!visited.has(sourceEntityId)) {
            queue.push(sourceEntityId);
          }
          continue;
        }

        this.removeComponentImmediate(sourceEntityId, componentType, cur);
      }

      this.entityReferences.delete(cur);
      archetype.removeEntity(cur);
      this.entityToArchetype.delete(cur);
      this.cleanupArchetypesReferencingEntity(cur);
      this.entityIdManager.deallocate(cur);
    }
  }

  exists(entityId: EntityId): boolean {
    return this.entityToArchetype.has(entityId);
  }

  set(entityId: EntityId, componentType: EntityId<void>): void;
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  set(entityId: EntityId, componentType: EntityId, component?: any): void {
    if (!this.exists(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }
    if (detailedType.type === "wildcard-relation") {
      throw new Error(`Cannot directly add wildcard relation components: ${componentType}`);
    }

    this.commandBuffer.set(entityId, componentType, component);
  }

  remove<T>(entityId: EntityId, componentType: EntityId<T>): void {
    if (!this.exists(entityId)) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "invalid") {
      throw new Error(`Invalid component type: ${componentType}`);
    }

    this.commandBuffer.remove(entityId, componentType);
  }

  delete(entityId: EntityId): void {
    this.commandBuffer.delete(entityId);
  }

  has<T>(entityId: EntityId, componentType: EntityId<T>): boolean {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) return false;

    if (archetype.componentTypes.includes(componentType)) return true;

    if (isDontFragmentRelation(componentType)) {
      return this.dontFragmentRelations.get(entityId)?.has(componentType) ?? false;
    }

    return false;
  }

  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, T][];
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (componentType >= 0 || componentType % 2 ** 42 !== 0) {
      const inArchetype = archetype.componentTypes.includes(componentType);
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

  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined {
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
   * @deprecated use array overload with LifecycleCallback
   */
  hook<T>(componentType: EntityId<T>, hook: LegacyLifecycleHook<T> | LegacyLifecycleCallback<T>): void;
  hook<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    hook: LifecycleHook<T> | LifecycleCallback<T>,
  ): void;
  hook(
    componentTypesOrSingle: EntityId<any> | readonly ComponentType<any>[],
    hook: LegacyLifecycleHook<any> | LifecycleHook<any> | LegacyLifecycleCallback<any> | LifecycleCallback<any>,
  ): void {
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
    } else {
      const componentType = componentTypesOrSingle as EntityId<any>;
      if (!this.legacyHooks.has(componentType)) {
        this.legacyHooks.set(componentType, new Set());
      }
      this.legacyHooks.get(componentType)!.add(hook as LegacyLifecycleHook<any>);

      const singleHook = hook as LegacyLifecycleHook<any>;
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

  unhook<T>(componentType: EntityId<T>, hook: LegacyLifecycleHook<T>): void;
  unhook<const T extends readonly ComponentType<any>[]>(componentTypes: T, hook: LifecycleHook<T>): void;
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

  sync(): void {
    this.commandBuffer.execute();
  }

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
    this.queryCache.set(key, { query, refCount: 1 });
    return query;
  }

  spawn(): EntityBuilder {
    return new EntityBuilder(this);
  }

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

  releaseQuery(query: Query): void {
    for (const [k, v] of this.queryCache.entries()) {
      if (v.query === query) {
        v.refCount--;
        if (v.refCount <= 0) {
          this.queryCache.delete(k);
          this._unregisterQuery(query);
          v.query._disposeInternal();
        }
        return;
      }
    }
  }

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

    const archetypeLists = componentTypes.map((type) => this.archetypesByComponent.get(type) || []);
    const firstList = archetypeLists[0]!;
    return firstList.filter((archetype) => archetypeLists.slice(1).every((list) => list.includes(archetype)));
  }

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
      } else if (componentType >= 1024) {
        untrackEntityReference(this.entityReferences, entityId, componentType, componentType);
      }
    }

    for (const [componentType] of changeset.adds) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        trackEntityReference(this.entityReferences, entityId, componentType, targetId);
      } else if (componentType >= 1024) {
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
      return archetype.componentTypes.includes(c) || isDontFragmentRelation(c);
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
