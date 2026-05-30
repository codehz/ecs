import { normalizeComponentTypes } from "../component/type-utils";
import type { EntityId, WildcardRelationId } from "../entity";
import {
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  isDontFragmentComponent,
  isWildcardRelationId,
} from "../entity";
import type { SerializedComponent, SerializedEntity, SerializedEntityId } from "../storage/serialization";
import { isOptionalEntityId, type ComponentTuple, type ComponentType, type LifecycleHookEntry } from "../types";
import { getOrCompute } from "../utils/utils";
import { buildCacheKey, buildSingleComponent, getWildcardRelationDataSource, isRelationType } from "./helpers";
import type { DontFragmentStore } from "./store";

/**
 * Special value to represent missing component data
 */
export const MISSING_COMPONENT = Symbol("missing component");

/**
 * Archetype class for ECS architecture
 * Represents a group of entities that share the same set of components
 * Optimized for fast iteration and component access
 */
export class Archetype {
  /**
   * The component types that define this archetype
   */
  public readonly componentTypes: EntityId<any>[];

  /**
   * Set version of componentTypes for O(1) lookups in hot paths
   */
  public readonly componentTypeSet: ReadonlySet<EntityId<any>>;

  /**
   * List of entities in this archetype
   */
  private entities: EntityId[] = [];

  /**
   * Component data storage - maps component type to array of component data
   * Each array index corresponds to the entity index in the entities array
   */
  private componentData: Map<EntityId<any>, any[]> = new Map();

  /**
   * Reverse mapping from entity to its index in this archetype
   */
  private entityToIndex: Map<EntityId, number> = new Map();

  /**
   * DontFragmentStore (keyed primarily by relation ComponentId).
   * Uses optimized RelationEntry (single/multi) for the common exclusive case.
   * See store.ts for implementation details.
   */
  private dontFragmentRelations: DontFragmentStore;

  /**
   * Multi-hooks that match this archetype
   */
  public readonly matchingMultiHooks: Set<LifecycleHookEntry> = new Set();

  /**
   * Cache for pre-computed component data sources to avoid repeated calculations
   */
  private componentDataSourcesCache: Map<string, (any[] | EntityId<any>[] | undefined)[]> = new Map();

  constructor(componentTypes: EntityId<any>[], dontFragmentRelations: DontFragmentStore) {
    this.componentTypes = normalizeComponentTypes(componentTypes);
    this.componentTypeSet = new Set(this.componentTypes);
    this.dontFragmentRelations = dontFragmentRelations;

    for (const componentType of this.componentTypes) {
      this.componentData.set(componentType, []);
    }
  }

  get size(): number {
    return this.entities.length;
  }

  /**
   * Check if the given component types match this archetype
   * @param componentTypes - Component types to check (can be in any order)
   * @returns true if the types match this archetype's component set
   * @note This method handles unsorted input by internally sorting for comparison
   */
  matches(componentTypes: EntityId<any>[]): boolean {
    if (this.componentTypes.length !== componentTypes.length) return false;
    const sortedTypes = normalizeComponentTypes(componentTypes);
    return this.componentTypes.every((type, index) => type === sortedTypes[index]);
  }

  addEntity(entityId: EntityId, componentData: Map<EntityId<any>, any>): void {
    if (this.entityToIndex.has(entityId)) {
      throw new Error(`Entity ${entityId} is already in this archetype`);
    }

    const index = this.entities.length;
    this.entities.push(entityId);
    this.entityToIndex.set(entityId, index);

    // Add component data for regular components
    for (const componentType of this.componentTypes) {
      const data = componentData.get(componentType);
      this.getComponentData(componentType).push(!componentData.has(componentType) ? MISSING_COMPONENT : data);
    }

    // Add dontFragment relations separately
    this.addDontFragmentRelations(entityId, componentData);
  }

  private addDontFragmentRelations(entityId: EntityId, componentData: Map<EntityId<any>, any>): void {
    for (const [componentType, data] of componentData) {
      if (this.componentTypeSet.has(componentType)) continue;

      const detailedType = getDetailedIdType(componentType);
      if (isRelationType(detailedType) && isDontFragmentComponent(detailedType.componentId!)) {
        this.dontFragmentRelations.setValue(entityId, componentType, data);
      }
    }
  }

  getEntity(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) return undefined;

    const entityData = new Map<EntityId<any>, any>();

    // Add regular components
    for (const componentType of this.componentTypes) {
      const data = this.getComponentData(componentType)[index];
      entityData.set(componentType, data === MISSING_COMPONENT ? undefined : data);
    }

    // Add dontFragment relations
    const dontFragmentTuples = this.dontFragmentRelations.getAllForEntity(entityId);
    for (const [componentType, data] of dontFragmentTuples) {
      entityData.set(componentType, data);
    }

    return entityData;
  }

  /**
   * Returns all dontFragment relations for the given entity as an array of tuples.
   * This is a compatibility adapter during the store refactor.
   *
   * Prefer the new DontFragmentStore methods when possible.
   */
  getEntityDontFragmentRelations(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const tuples = this.dontFragmentRelations.getAllForEntity(entityId);
    if (tuples.length === 0) return undefined;

    const map = new Map<EntityId<any>, any>();
    for (const [relType, data] of tuples) {
      map.set(relType, data);
    }
    return map;
  }

  dump(): Array<{ entity: EntityId; components: Map<EntityId<any>, any> }> {
    return this.entities.map((entity, i) => {
      const components = new Map<EntityId<any>, any>();

      for (const componentType of this.componentTypes) {
        const data = this.getComponentData(componentType)[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }

      const dontFragmentTuples = this.dontFragmentRelations.getAllForEntity(entity);
      for (const [componentType, data] of dontFragmentTuples) {
        components.set(componentType, data);
      }

      return { entity, components };
    });
  }

  /**
   * @internal Serialization fast-path.
   *
   * Appends SerializedEntity records directly from the archetype's column storage
   * (componentData arrays) plus dontFragment relations, avoiding per-entity Map
   * allocation and repeated Array.from(entries()).
   *
   * Component type IDs should be pre-encoded by the caller (once per archetype)
   * and passed in `encodedComponentTypes` (same order and length as this.componentTypes).
   *
   * The provided `encode` function should be the cached variant for best performance
   * on entity IDs and any dontFragment relation type IDs.
   *
   * `dontFragmentByEntity` is an optional pre-fetched map from a bulk
   * `DontFragmentStore.getAllForEntities` call (further reduces per-entity calls).
   */
  appendSerializedEntities(
    out: SerializedEntity[],
    encode: (id: EntityId<any>) => SerializedEntityId,
    encodedComponentTypes: SerializedEntityId[],
    dontFragmentByEntity?: Map<EntityId, Array<[EntityId<any>, any]>>,
  ): void {
    if (encodedComponentTypes.length !== this.componentTypes.length) {
      throw new Error("encodedComponentTypes length must match archetype componentTypes");
    }

    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i]!;

      const components: SerializedComponent[] = [];
      // Regular (non-dontFragment) components from column arrays
      for (let c = 0; c < this.componentTypes.length; c++) {
        const data = this.getComponentData(this.componentTypes[c]!)[i];
        components.push({
          type: encodedComponentTypes[c]!,
          value: data === MISSING_COMPONENT ? undefined : data,
        });
      }

      // Append any dontFragment relations for this entity (usually small or zero)
      const dontFragmentTuples =
        dontFragmentByEntity?.get(entity) ?? this.dontFragmentRelations.getAllForEntity(entity);
      for (const [componentType, data] of dontFragmentTuples) {
        components.push({
          type: encode(componentType),
          value: data,
        });
      }

      out.push({
        id: encode(entity),
        components,
      });
    }
  }

  removeEntity(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) return undefined;

    // Extract component data before removal
    const removedData = new Map<EntityId<any>, any>();
    for (const componentType of this.componentTypes) {
      removedData.set(componentType, this.getComponentData(componentType)[index]);
    }

    // Include dontFragment relations
    const dontFragmentTuples = this.dontFragmentRelations.getAllForEntity(entityId);
    for (const [componentType, data] of dontFragmentTuples) {
      removedData.set(componentType, data);
    }
    this.dontFragmentRelations.deleteEntity(entityId);

    this.entityToIndex.delete(entityId);

    // Swap-and-pop for O(1) removal
    const lastIndex = this.entities.length - 1;
    if (index !== lastIndex) {
      const lastEntity = this.entities[lastIndex]!;
      this.entities[index] = lastEntity;
      this.entityToIndex.set(lastEntity, index);

      for (const componentType of this.componentTypes) {
        const dataArray = this.getComponentData(componentType);
        dataArray[index] = dataArray[lastIndex];
      }
    }

    this.entities.pop();
    for (const componentType of this.componentTypes) {
      this.getComponentData(componentType).pop();
    }

    return removedData;
  }

  exists(entityId: EntityId): boolean {
    return this.entityToIndex.has(entityId);
  }

  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, any][];
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    if (isWildcardRelationId(componentType)) {
      return this.getWildcardRelations(entityId, index, componentType);
    }

    return this.getRegularComponent(entityId, index, componentType);
  }

  private getWildcardRelations<T>(
    entityId: EntityId,
    index: number,
    componentType: WildcardRelationId<T>,
  ): [EntityId<unknown>, any][] {
    const componentId = getComponentIdFromRelationId(componentType);
    const relations: [EntityId<unknown>, any][] = [];

    // Check regular archetype components
    for (const relType of this.componentTypes) {
      const relDetailed = getDetailedIdType(relType);
      if (isRelationType(relDetailed) && relDetailed.componentId === componentId) {
        const dataArray = this.getComponentData(relType);
        if (dataArray && dataArray[index] !== undefined) {
          const data = dataArray[index];
          relations.push([relDetailed.targetId, data === MISSING_COMPONENT ? undefined : data]);
        }
      }
    }

    // Check dontFragment relations (now uses the efficient per-component path)
    if (componentId !== undefined) {
      const matches = this.dontFragmentRelations.getRelationsForComponent(entityId, componentId);
      for (const m of matches) relations.push(m);
    }

    return relations;
  }

  private getRegularComponent<T>(entityId: EntityId, index: number, componentType: EntityId<T>): T {
    if (this.componentTypeSet.has(componentType)) {
      const data = this.getComponentData(componentType)[index]!;
      if (data === MISSING_COMPONENT) {
        throw new Error(`Component type ${componentType} not found for entity ${entityId}`);
      }
      return data as T;
    }

    const value = this.dontFragmentRelations.getValue(entityId, componentType);
    if (
      value !== undefined ||
      this.dontFragmentRelations.getAllForEntity(entityId).some(([t]) => t === componentType)
    ) {
      // Note: the extra check above handles the (rare) case where `undefined` is a legitimate stored value.
      // For the common case we just return whatever getValue gave us.
      return this.dontFragmentRelations.getValue(entityId, componentType);
    }

    throw new Error(`Component type ${componentType} not found for entity ${entityId}`);
  }

  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    if (this.componentTypeSet.has(componentType)) {
      const data = this.getComponentData(componentType)[index]!;
      if (data === MISSING_COMPONENT) return undefined;
      return { value: data as T };
    }

    const value = this.dontFragmentRelations.getValue(entityId, componentType);
    // We use getAllForEntity only as a presence check when the value itself might be undefined.
    if (value !== undefined) {
      return { value };
    }
    const all = this.dontFragmentRelations.getAllForEntity(entityId);
    if (all.some(([t]) => t === componentType)) {
      return { value: this.dontFragmentRelations.getValue(entityId, componentType) };
    }
    return undefined;
  }

  set<T>(entityId: EntityId, componentType: EntityId<T>, data: T): void {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    if (this.componentData.has(componentType)) {
      this.getComponentData(componentType)[index] = data;
      return;
    }

    const detailedType = getDetailedIdType(componentType);
    if (isRelationType(detailedType) && isDontFragmentComponent(detailedType.componentId!)) {
      this.dontFragmentRelations.setValue(entityId, componentType, data);
      return;
    }

    throw new Error(`Component type ${componentType} is not in this archetype`);
  }

  getEntities(): EntityId[] {
    return this.entities;
  }

  getEntityToIndexMap(): Map<EntityId, number> {
    return this.entityToIndex;
  }

  getComponentData<T>(componentType: EntityId<T>): T[] {
    const data = this.componentData.get(componentType);
    if (!data) {
      throw new Error(`Component type ${componentType} is not in this archetype`);
    }
    return data;
  }

  getOptionalComponentData<T>(componentType: EntityId<T>): T[] | undefined {
    return this.componentData.get(componentType);
  }

  private getCachedComponentDataSources<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): (any[] | EntityId<any>[] | undefined)[] {
    const cacheKey = buildCacheKey(componentTypes);
    return getOrCompute(this.componentDataSourcesCache, cacheKey, () =>
      componentTypes.map((compType) => this.getComponentDataSource(compType)),
    );
  }

  private getComponentDataSource(compType: ComponentType<any>): any[] | EntityId<any>[] | undefined {
    const optional = isOptionalEntityId(compType);
    const actualType = optional ? compType.optional : compType;
    const idType = getIdType(actualType);

    if (idType === "wildcard-relation") {
      const componentId = getComponentIdFromRelationId(actualType)!;
      return getWildcardRelationDataSource(this.componentTypes, componentId, optional);
    }

    return optional ? this.getOptionalComponentData(actualType) : this.getComponentData(actualType);
  }

  private buildComponentsForIndex<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    componentDataSources: (any[] | EntityId<any>[] | undefined)[],
    entityIndex: number,
    entityId: EntityId,
  ): ComponentTuple<T> {
    return componentDataSources.map((dataSource, i) =>
      buildSingleComponent(
        componentTypes[i]!,
        dataSource,
        entityIndex,
        entityId,
        (type) => this.getComponentData(type),
        this.dontFragmentRelations,
      ),
    ) as ComponentTuple<T>;
  }

  getEntitiesWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): Array<{ entity: EntityId; components: ComponentTuple<T> }> {
    const result: Array<{ entity: EntityId; components: ComponentTuple<T> }> = [];
    this.appendEntitiesWithComponents(componentTypes, result);
    return result;
  }

  appendEntitiesWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    result: Array<{ entity: EntityId; components: ComponentTuple<T> }>,
  ): void {
    this.forEachWithComponents(componentTypes, (entity, ...components) => {
      result.push({ entity, components });
    });
  }

  *iterateWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): IterableIterator<[EntityId, ...ComponentTuple<T>]> {
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;
      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);
      yield [entity, ...components];
    }
  }

  forEachWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
  ): void {
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;
      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);
      callback(entity, ...components);
    }
  }

  forEach(callback: (entityId: EntityId, components: Map<EntityId<any>, any>) => void): void {
    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i]!;
      const components = new Map<EntityId<any>, any>();
      for (const componentType of this.componentTypes) {
        const data = this.getComponentData(componentType)[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }

      // Append dontFragment relations (Y-class path, acceptable cost)
      const dontFragmentTuples = this.dontFragmentRelations.getAllForEntity(entity);
      for (const [componentType, data] of dontFragmentTuples) {
        components.set(componentType, data);
      }

      callback(entity, components);
    }
  }

  hasRelationWithComponentId(componentId: EntityId<any>): boolean {
    // Check regular archetype components
    for (const componentType of this.componentTypes) {
      const detailedType = getDetailedIdType(componentType);
      if (isRelationType(detailedType) && detailedType.componentId === componentId) {
        return true;
      }
    }

    // Check dontFragment relations only for entities that actually belong to *this* archetype.
    // We must not use the global hasAnyForComponent here, otherwise unrelated archetypes
    // can be incorrectly pulled into wildcard queries when any entity in the world has the relation.
    for (const entityId of this.entities) {
      const rels = this.dontFragmentRelations.getRelationsForComponent(entityId, componentId);
      if (rels.length > 0) {
        return true;
      }
    }
    return false;
  }
}
