import type { EntityId, RelationId, WildcardRelationId } from "./entity";
import { decodeRelationId, getDetailedIdType, getIdType, isWildcardRelationId } from "./entity";
import type { ComponentTuple } from "./types";
import { getOrComputeCache } from "./utils";

/**
 * Special value to represent missing component data
 */
const MISSING_COMPONENT = Symbol("missing component");

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
   * Cache for pre-computed component data sources to avoid repeated calculations
   * For regular components: data array
   * For wildcards: matching relation types array
   */
  private componentDataSourcesCache: Map<string, (any[] | EntityId<any>[])[]> = new Map();

  /**
   * Create a new archetype with the specified component types
   * @param componentTypes The component types that define this archetype
   */
  constructor(componentTypes: EntityId<any>[]) {
    this.componentTypes = [...componentTypes].sort((a, b) => a - b); // Sort for consistent ordering

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
   * @param componentData Map of component type to component data
   */
  addEntity(entityId: EntityId, componentData: Map<EntityId<any>, any>): void {
    if (this.entityToIndex.has(entityId)) {
      throw new Error(`Entity ${entityId} is already in this archetype`);
    }

    const index = this.entities.length;
    this.entities.push(entityId);
    this.entityToIndex.set(entityId, index);

    // Add component data
    for (const componentType of this.componentTypes) {
      const data = componentData.get(componentType);
      this.getComponentData(componentType).push(data === undefined ? MISSING_COMPONENT : data);
    }
  }

  /**
   * Remove an entity from this archetype
   * @param entityId The entity to remove
   * @returns The component data of the removed entity
   */
  removeEntity(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      return undefined;
    }

    // Remove from entity list
    this.entities.splice(index, 1);
    this.entityToIndex.delete(entityId);

    // Extract component data
    const removedData = new Map<EntityId<any>, any>();
    for (const componentType of this.componentTypes) {
      const dataArray = this.getComponentData(componentType);
      removedData.set(componentType, dataArray[index]);
      dataArray.splice(index, 1);
    }

    // Update indices for remaining entities
    for (let i = index; i < this.entities.length; i++) {
      this.entityToIndex.set(this.entities[i]!, i);
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
      const decoded = decodeRelationId(componentType);
      const componentId = decoded.componentId;
      const relations: [EntityId<unknown>, any][] = [];

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

      return relations;
    } else {
      const data = this.getComponentData(componentType)[index]!;
      return data === MISSING_COMPONENT ? (undefined as T) : data;
    }
  }

  /**
   * Set component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @param data The component data
   */
  set<T>(entityId: EntityId, componentType: EntityId<T>, data: T): void {
    if (!this.componentData.has(componentType)) {
      throw new Error(`Component type ${componentType} is not in this archetype`);
    }
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }
    const dataArray = this.getComponentData(componentType);
    dataArray[index] = data;
  }

  /**
   * Get all entities in this archetype
   */
  getEntities(): EntityId[] {
    return this.entities;
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
   * Get entities with their component data for specified component types
   * Optimized for bulk component access with pre-computed indices
   * @param componentTypes Array of component types to retrieve
   * @returns Array of objects with entity and component data
   */
  getEntitiesWithComponents<const T extends readonly EntityId<any>[]>(
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
   * Optimized for bulk component access
   * @param componentTypes Array of component types to retrieve
   * @param callback Function called for each entity with its components
   */
  forEachWithComponents<const T extends readonly EntityId<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
  ): void {
    // Create a cache key from component types
    const cacheKey = componentTypes.map((id) => id.toString()).join(",");

    // Get or compute component data sources
    const componentDataSources = getOrComputeCache(this.componentDataSourcesCache, cacheKey, () => {
      // Pre-cache data sources for component types to avoid repeated calculations
      // For wildcard relations, cache the matching relation types
      // For regular components, cache the data array reference
      return componentTypes.map((compType) => {
        const detailedType = getDetailedIdType(compType);
        if (detailedType.type === "wildcard-relation") {
          const componentId = detailedType.componentId;

          // Find all concrete relation componentTypes in this archetype that match the wildcard
          const matchingRelations = this.componentTypes.filter((ct) => {
            const detailedCt = getDetailedIdType(ct);
            if (detailedCt.type !== "entity-relation" && detailedCt.type !== "component-relation") return false;
            return detailedCt.componentId === componentId;
          });

          return matchingRelations;
        } else {
          return this.getComponentData(compType);
        }
      });
    });

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;

      // Direct array access for each component type using pre-cached sources
      const components = componentDataSources.map((dataSource, i) => {
        const compType = componentTypes[i]!;
        if (getIdType(compType) === "wildcard-relation") {
          // Compute relations dynamically using cached matching relations
          const matchingRelations = dataSource as EntityId<any>[];
          const relations: [EntityId<unknown>, any][] = [];
          for (const relType of matchingRelations) {
            const dataArray = this.getComponentData(relType);
            const data = dataArray[entityIndex];
            const decodedRel = decodeRelationId(relType as RelationId<any>);
            relations.push([decodedRel.targetId, data === MISSING_COMPONENT ? undefined : data]);
          }
          return relations;
        } else {
          const dataArray = dataSource as any[];
          const data = dataArray ? dataArray[entityIndex] : undefined;
          return data === MISSING_COMPONENT ? undefined : data;
        }
      }) as ComponentTuple<T>;

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
}
