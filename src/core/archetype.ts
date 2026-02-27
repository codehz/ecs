import { getOrCompute } from "../utils/utils";
import {
  buildCacheKey,
  buildSingleComponent,
  findMatchingDontFragmentRelations,
  getWildcardRelationDataSource,
  isRelationType,
} from "./archetype-helpers";
import { normalizeComponentTypes } from "./component-type-utils";
import type { EntityId, WildcardRelationId } from "./entity";
import {
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  isDontFragmentComponent,
  isWildcardRelationId,
} from "./entity";
import { isOptionalEntityId, type ComponentTuple, type ComponentType, type LifecycleHookEntry } from "./types";

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
   * Reference to dontFragment relations storage from World
   * This allows entities with different relation targets to share the same archetype
   * Stored in World to avoid migration overhead when entities change archetypes
   */
  private dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>;

  /**
   * Multi-hooks that match this archetype
   */
  public readonly matchingMultiHooks: Set<LifecycleHookEntry> = new Set();

  /**
   * Cache for pre-computed component data sources to avoid repeated calculations
   */
  private componentDataSourcesCache: Map<string, (any[] | EntityId<any>[] | undefined)[]> = new Map();

  constructor(componentTypes: EntityId<any>[], dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>) {
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
    const dontFragmentData = new Map<EntityId<any>, any>();

    for (const [componentType, data] of componentData) {
      if (this.componentTypeSet.has(componentType)) continue;

      const detailedType = getDetailedIdType(componentType);
      if (isRelationType(detailedType) && isDontFragmentComponent(detailedType.componentId!)) {
        dontFragmentData.set(componentType, data);
      }
    }

    if (dontFragmentData.size > 0) {
      this.dontFragmentRelations.set(entityId, dontFragmentData);
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
    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData) {
      for (const [componentType, data] of dontFragmentData) {
        entityData.set(componentType, data);
      }
    }

    return entityData;
  }

  getEntityDontFragmentRelations(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    return this.dontFragmentRelations.get(entityId);
  }

  dump(): Array<{ entity: EntityId; components: Map<EntityId<any>, any> }> {
    return this.entities.map((entity, i) => {
      const components = new Map<EntityId<any>, any>();

      for (const componentType of this.componentTypes) {
        const data = this.getComponentData(componentType)[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }

      const dontFragmentData = this.dontFragmentRelations.get(entity);
      if (dontFragmentData) {
        for (const [componentType, data] of dontFragmentData) {
          components.set(componentType, data);
        }
      }

      return { entity, components };
    });
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
    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData) {
      for (const [componentType, data] of dontFragmentData) {
        removedData.set(componentType, data);
      }
      this.dontFragmentRelations.delete(entityId);
    }

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

    // Check dontFragment relations
    if (componentId !== undefined) {
      relations.push(...findMatchingDontFragmentRelations(this.dontFragmentRelations.get(entityId), componentId));
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

    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData?.has(componentType)) {
      return dontFragmentData.get(componentType);
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

    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData?.has(componentType)) {
      return { value: dontFragmentData.get(componentType) };
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
      let dontFragmentData = this.dontFragmentRelations.get(entityId);
      if (!dontFragmentData) {
        dontFragmentData = new Map();
        this.dontFragmentRelations.set(entityId, dontFragmentData);
      }
      dontFragmentData.set(componentType, data);
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
    this.forEachWithComponents(componentTypes, (entity, ...components) => {
      result.push({ entity, components });
    });
    return result;
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
      const components = new Map<EntityId<any>, any>();
      for (const componentType of this.componentTypes) {
        const data = this.getComponentData(componentType)[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }
      callback(this.entities[i]!, components);
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

    // Check dontFragment relations
    for (const entityId of this.entities) {
      const entityDontFragmentRelations = this.dontFragmentRelations.get(entityId);
      if (entityDontFragmentRelations) {
        for (const relationType of entityDontFragmentRelations.keys()) {
          const detailedType = getDetailedIdType(relationType);
          if (isRelationType(detailedType) && detailedType.componentId === componentId) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
