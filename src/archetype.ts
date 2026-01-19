import type { EntityId, WildcardRelationId } from "./entity";
import {
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  getTargetIdFromRelationId,
  isDontFragmentComponent,
  isWildcardRelationId,
} from "./entity";
import { isOptionalEntityId, type ComponentTuple, type ComponentType } from "./types";
import { getOrComputeCache } from "./utils";

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
   * Cache for pre-computed component data sources to avoid repeated calculations
   * For regular components: data array
   * For wildcards: matching relation types array
   */
  private componentDataSourcesCache: Map<string, (any[] | EntityId<any>[] | undefined)[]> = new Map();

  /**
   * Create a new archetype with the specified component types
   * @param componentTypes The component types that define this archetype
   * @param dontFragmentRelations Reference to the World's dontFragmentRelations storage
   */
  constructor(componentTypes: EntityId<any>[], dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>) {
    this.componentTypes = [...componentTypes].sort((a, b) => a - b); // Sort for consistent ordering
    this.dontFragmentRelations = dontFragmentRelations;

    // Initialize component data arrays
    for (const componentType of this.componentTypes) {
      this.componentData.set(componentType, []);
    }
  }

  /**
   * Get the number of entities in this archetype
   */
  get size(): number {
    return this.entities.length;
  }

  /**
   * Check if this archetype matches the given component types
   * @param componentTypes The component types to check
   */
  matches(componentTypes: EntityId<any>[]): boolean {
    if (this.componentTypes.length !== componentTypes.length) {
      return false;
    }
    const sortedTypes = [...componentTypes].sort((a, b) => a - b);
    return this.componentTypes.every((type, index) => type === sortedTypes[index]);
  }

  /**
   * Add an entity to this archetype with initial component data
   * @param entityId The entity to add
   * @param componentData Map of component type to component data (includes both regular and dontFragment components)
   */
  addEntity(entityId: EntityId, componentData: Map<EntityId<any>, any>): void {
    if (this.entityToIndex.has(entityId)) {
      throw new Error(`Entity ${entityId} is already in this archetype`);
    }

    const index = this.entities.length;
    this.entities.push(entityId);
    this.entityToIndex.set(entityId, index);

    // Add component data for regular components (those in the archetype signature)
    for (const componentType of this.componentTypes) {
      const data = componentData.get(componentType);
      this.getComponentData(componentType).push(!componentData.has(componentType) ? MISSING_COMPONENT : data);
    }

    // Add dontFragment relations separately
    const dontFragmentData = new Map<EntityId<any>, any>();
    for (const [componentType, data] of componentData) {
      // Skip if already added as regular component
      if (this.componentTypes.includes(componentType)) {
        continue;
      }

      // Check if this is a dontFragment relation
      const detailedType = getDetailedIdType(componentType);
      if (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        isDontFragmentComponent(detailedType.componentId!)
      ) {
        dontFragmentData.set(componentType, data);
      }
    }

    if (dontFragmentData.size > 0) {
      this.dontFragmentRelations.set(entityId, dontFragmentData);
    }
  }

  /**
   * Get all component data for a specific entity
   * @param entityId The entity to get data for
   * @returns Map of component type to component data (includes both regular and dontFragment components)
   */
  getEntity(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      return undefined;
    }

    const entityData = new Map<EntityId<any>, any>();
    for (const componentType of this.componentTypes) {
      const dataArray = this.getComponentData(componentType);
      const data = dataArray[index];
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

  /**
   * Dump all entities and their component data in this archetype
   * @returns Array of objects with entity and component data (includes both regular and dontFragment components)
   */
  dump(): Array<{
    entity: EntityId;
    components: Map<EntityId<any>, any>;
  }> {
    const result: Array<{
      entity: EntityId;
      components: Map<EntityId<any>, any>;
    }> = [];

    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i]!;
      const components = new Map<EntityId<any>, any>();
      for (const componentType of this.componentTypes) {
        const dataArray = this.getComponentData(componentType);
        const data = dataArray[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }

      // Add dontFragment relations
      const dontFragmentData = this.dontFragmentRelations.get(entity);
      if (dontFragmentData) {
        for (const [componentType, data] of dontFragmentData) {
          components.set(componentType, data);
        }
      }

      result.push({ entity, components });
    }

    return result;
  }

  /**
   * Remove an entity from this archetype
   * @param entityId The entity to remove
   * @returns The component data of the removed entity (includes both regular and dontFragment components)
   */
  removeEntity(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      return undefined;
    }

    // Extract component data before removal
    const removedData = new Map<EntityId<any>, any>();
    for (const componentType of this.componentTypes) {
      const dataArray = this.getComponentData(componentType);
      removedData.set(componentType, dataArray[index]);
    }

    // Include dontFragment relations in removed data
    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData) {
      for (const [componentType, data] of dontFragmentData) {
        removedData.set(componentType, data);
      }
      this.dontFragmentRelations.delete(entityId);
    }

    this.entityToIndex.delete(entityId);

    // Use swap-and-pop strategy for O(1) removal instead of O(n) splice
    const lastIndex = this.entities.length - 1;
    if (index !== lastIndex) {
      // Swap with last entity
      const lastEntity = this.entities[lastIndex]!;
      this.entities[index] = lastEntity;
      this.entityToIndex.set(lastEntity, index);

      // Swap component data for all components
      for (const componentType of this.componentTypes) {
        const dataArray = this.getComponentData(componentType);
        dataArray[index] = dataArray[lastIndex];
      }
    }

    // Remove the last element (now O(1))
    this.entities.pop();
    for (const componentType of this.componentTypes) {
      this.getComponentData(componentType).pop();
    }

    return removedData;
  }

  /**
   * Check if an entity is in this archetype
   * @param entityId The entity to check
   */
  exists(entityId: EntityId): boolean {
    return this.entityToIndex.has(entityId);
  }

  /**
   * Get component data for a specific entity and wildcard relation type
   * Returns an array of all matching relation instances
   * @param entityId The entity
   * @param componentType The wildcard relation type
   */
  get<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, any][];
  /**
   * Get component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   */
  get<T>(entityId: EntityId, componentType: EntityId<T>): T;
  get<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    if (isWildcardRelationId(componentType)) {
      const componentId = getComponentIdFromRelationId(componentType);
      const relations: [EntityId<unknown>, any][] = [];

      // Check regular archetype components
      for (const relType of this.componentTypes) {
        const relDetailed = getDetailedIdType(relType);
        if (
          (relDetailed.type === "entity-relation" || relDetailed.type === "component-relation") &&
          relDetailed.componentId === componentId
        ) {
          const dataArray = this.getComponentData(relType);
          if (dataArray && dataArray[index] !== undefined) {
            const data = dataArray[index];
            relations.push([relDetailed.targetId, data === MISSING_COMPONENT ? undefined : data]);
          }
        }
      }

      // Check dontFragment relations
      const dontFragmentData = this.dontFragmentRelations.get(entityId);
      if (dontFragmentData) {
        for (const [relType, data] of dontFragmentData) {
          const relDetailed = getDetailedIdType(relType);
          if (
            (relDetailed.type === "entity-relation" || relDetailed.type === "component-relation") &&
            relDetailed.componentId === componentId
          ) {
            relations.push([relDetailed.targetId, data]);
          }
        }
      }

      return relations;
    } else {
      // First check if it's in the archetype signature
      if (this.componentTypes.includes(componentType)) {
        const data = this.getComponentData(componentType)[index]!;
        if (data === MISSING_COMPONENT) {
          throw new Error(`Component type ${componentType} not found for entity ${entityId}`);
        }
        return data as T;
      }

      // Check dontFragment relations
      const dontFragmentData = this.dontFragmentRelations.get(entityId);
      if (dontFragmentData && dontFragmentData.has(componentType)) {
        return dontFragmentData.get(componentType);
      }

      throw new Error(`Component type ${componentType} not found for entity ${entityId}`);
    }
  }

  /**
   * Get optional component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @returns { value: T } if component exists, undefined otherwise
   */
  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    // First check if it's in the archetype signature
    if (this.componentTypes.includes(componentType)) {
      const data = this.getComponentData(componentType)[index]!;
      if (data === MISSING_COMPONENT) {
        return undefined;
      }
      return { value: data as T };
    }

    // Check dontFragment relations
    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData && dontFragmentData.has(componentType)) {
      return { value: dontFragmentData.get(componentType) };
    }

    return undefined;
  }

  /**
   * Set component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @param data The component data
   */
  set<T>(entityId: EntityId, componentType: EntityId<T>, data: T): void {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    // Check if it's in the archetype signature
    if (this.componentData.has(componentType)) {
      const dataArray = this.getComponentData(componentType);
      dataArray[index] = data;
      return;
    }

    // Check if it's a dontFragment relation
    const detailedType = getDetailedIdType(componentType);
    if (
      (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
      isDontFragmentComponent(detailedType.componentId!)
    ) {
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

  /**
   * Get all entities in this archetype
   */
  getEntities(): EntityId[] {
    return this.entities;
  }

  /**
   * Get the mapping of entities to their indices in this archetype
   */
  getEntityToIndexMap(): Map<EntityId, number> {
    return this.entityToIndex;
  }

  /**
   * Get component data for all entities of a specific component type
   * @param componentType The component type
   */
  getComponentData<T>(componentType: EntityId<T>): T[] {
    const data = this.componentData.get(componentType);
    if (!data) {
      throw new Error(`Component type ${componentType} is not in this archetype`);
    }
    return data;
  }

  /**
   * Get optional component data for all entities of a specific component type
   * @param componentType The component type
   * @returns An array of component data or undefined if not present
   */
  getOptionalComponentData<T>(componentType: EntityId<T>): T[] | undefined {
    return this.componentData.get(componentType);
  }

  /**
   * Helper: compute or return cached data sources for provided componentTypes
   */
  private getCachedComponentDataSources<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): (any[] | EntityId<any>[] | undefined)[] {
    const cacheKey = this.buildCacheKey(componentTypes);
    return getOrComputeCache(this.componentDataSourcesCache, cacheKey, () =>
      componentTypes.map((compType) => this.getComponentDataSource(compType)),
    );
  }

  /**
   * Build cache key for component types
   */
  private buildCacheKey(componentTypes: readonly ComponentType<any>[]): string {
    return componentTypes.map((id) => (isOptionalEntityId(id) ? `opt(${id.optional})` : `${id}`)).join(",");
  }

  /**
   * Get data source for a single component type
   */
  private getComponentDataSource(compType: ComponentType<any>): any[] | EntityId<any>[] | undefined {
    const optional = isOptionalEntityId(compType);
    const actualType = optional ? compType.optional : compType;
    const detailedType = getDetailedIdType(actualType);

    if (detailedType.type === "wildcard-relation") {
      return this.getWildcardRelationDataSource(detailedType.componentId, optional);
    } else {
      return optional ? this.getOptionalComponentData(actualType) : this.getComponentData(actualType);
    }
  }

  /**
   * Get data source for wildcard relations
   */
  private getWildcardRelationDataSource(componentId: EntityId<any>, optional: boolean): EntityId<any>[] | undefined {
    const matchingRelations = this.componentTypes.filter((ct) => {
      const detailedCt = getDetailedIdType(ct);
      return (
        (detailedCt.type === "entity-relation" || detailedCt.type === "component-relation") &&
        detailedCt.componentId === componentId
      );
    });

    return optional ? (matchingRelations.length > 0 ? matchingRelations : undefined) : matchingRelations;
  }

  /**
   * Helper: build component tuples for a specific entity index using precomputed data sources
   */
  private buildComponentsForIndex<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    componentDataSources: (any[] | EntityId<any>[] | undefined)[],
    entityIndex: number,
    entityId: EntityId,
  ): ComponentTuple<T> {
    return componentDataSources.map((dataSource, i) => {
      const compType = componentTypes[i]!;
      return this.buildSingleComponent(compType, dataSource, entityIndex, entityId);
    }) as ComponentTuple<T>;
  }

  /**
   * Build a single component value from its data source
   */
  private buildSingleComponent(
    compType: ComponentType<any>,
    dataSource: any[] | EntityId<any>[] | undefined,
    entityIndex: number,
    entityId: EntityId,
  ): any {
    const optional = isOptionalEntityId(compType);
    const actualType = optional ? compType.optional : compType;

    if (getIdType(actualType) === "wildcard-relation") {
      return this.buildWildcardRelationValue(
        actualType as WildcardRelationId<any>,
        dataSource,
        entityIndex,
        entityId,
        optional,
      );
    } else {
      return this.buildRegularComponentValue(dataSource, entityIndex, optional);
    }
  }

  /**
   * Build wildcard relation value from matching relations
   */
  private buildWildcardRelationValue(
    wildcardRelationType: WildcardRelationId<any>,
    dataSource: any[] | EntityId<any>[] | undefined,
    entityIndex: number,
    entityId: EntityId,
    optional: boolean,
  ): any {
    const matchingRelations = (dataSource as EntityId<any>[]) || [];
    const relations: [EntityId<unknown>, any][] = [];

    // Add regular archetype relations
    for (const relType of matchingRelations) {
      const dataArray = this.getComponentData(relType);
      const data = dataArray[entityIndex];
      const targetId = getTargetIdFromRelationId(relType)!;
      relations.push([targetId, data === MISSING_COMPONENT ? undefined : data]);
    }

    // Add dontFragment relations for this entity
    // Get the component ID from the wildcard relation type
    const targetComponentId = getComponentIdFromRelationId(wildcardRelationType);

    const dontFragmentData = this.dontFragmentRelations.get(entityId);
    if (dontFragmentData) {
      // Check dontFragment relations for matching component ID
      for (const [relType, data] of dontFragmentData) {
        const relDetailed = getDetailedIdType(relType);
        if (
          (relDetailed.type === "entity-relation" || relDetailed.type === "component-relation") &&
          relDetailed.componentId === targetComponentId
        ) {
          relations.push([relDetailed.targetId, data]);
        }
      }
    }

    // If no relations found and not optional, this entity doesn't match
    if (relations.length === 0) {
      if (!optional) {
        const componentId = getComponentIdFromRelationId(wildcardRelationType);
        throw new Error(
          `No matching relations found for mandatory wildcard relation component ${componentId} on entity ${entityId}`,
        );
      }
      // For optional, return undefined when there are no relations
      return undefined;
    }

    return optional ? { value: relations } : relations;
  }

  /**
   * Build regular component value from data source
   */
  private buildRegularComponentValue(
    dataSource: any[] | EntityId<any>[] | undefined,
    entityIndex: number,
    optional: boolean,
  ): any {
    if (dataSource === undefined) {
      if (optional) {
        return undefined;
      }
      throw new Error(`Component data not found for mandatory component type`);
    }

    const dataArray = dataSource as any[];
    const data = dataArray[entityIndex];
    const result = data === MISSING_COMPONENT ? undefined : data;

    return optional ? { value: result } : result;
  }

  /**
   * Get entities with their component data for specified component types
   * Optimized for bulk component access with pre-computed indices
   * @param componentTypes Array of component types to retrieve
   * @returns Array of objects with entity and component data
   */
  getEntitiesWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): Array<{
    entity: EntityId;
    components: ComponentTuple<T>;
  }> {
    const result: Array<{
      entity: EntityId;
      components: ComponentTuple<T>;
    }> = [];

    this.forEachWithComponents(componentTypes, (entity, ...components) => {
      result.push({ entity, components });
    });

    return result;
  }

  /**
   * Iterate over entities with their component data for specified component types
   * implemented as a generator returning each entity/components pair lazily
   * @param componentTypes Array of component types to retrieve
   */
  *iterateWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
  ): IterableIterator<[EntityId, ...ComponentTuple<T>]> {
    // Reuse the same pre-caching and data access logic as forEachWithComponents
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;

      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);

      yield [entity, ...components];
    }
  }

  /**
   * Iterate over entities with their component data for specified component types
   * Optimized for bulk component access
   * @param componentTypes Array of component types to retrieve
   * @param callback Function called for each entity with its components
   */
  forEachWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
  ): void {
    // Create a cache key from component types
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;

      // Direct array access for each component type using pre-cached sources
      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);

      callback(entity, ...components);
    }
  }

  /**
   * Iterate over all entities with their component data
   * @param callback Function called for each entity with its component data
   */
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

  /**
   * Check if any entity in this archetype has a relation matching the given component ID
   * This includes both regular relations in componentTypes and dontFragment relations
   * @param componentId The component ID to match
   * @returns true if any entity has a matching relation
   */
  hasRelationWithComponentId(componentId: EntityId<any>): boolean {
    // Check regular archetype components
    for (const componentType of this.componentTypes) {
      const detailedType = getDetailedIdType(componentType);
      if (
        (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
        detailedType.componentId === componentId
      ) {
        return true;
      }
    }

    // Check dontFragment relations for any entity in this archetype
    for (const entityId of this.entities) {
      const entityDontFragmentRelations = this.dontFragmentRelations.get(entityId);
      if (entityDontFragmentRelations) {
        for (const relationType of entityDontFragmentRelations.keys()) {
          const detailedType = getDetailedIdType(relationType);
          if (
            (detailedType.type === "entity-relation" || detailedType.type === "component-relation") &&
            detailedType.componentId === componentId
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
