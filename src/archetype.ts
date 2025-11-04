import type { EntityId, WildcardRelationId } from "./entity";
import { getIdType, decodeRelationId } from "./entity";
import type { ComponentTuple } from "./types";
import { getOrComputeCache } from "./utils";

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
      if (data === undefined) {
        throw new Error(`Missing component data for type ${componentType}`);
      }
      this.componentData.get(componentType)!.push(data);
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
      const dataArray = this.componentData.get(componentType)!;
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
  hasEntity(entityId: EntityId): boolean {
    return this.entityToIndex.has(entityId);
  }

  /**
   * Get component data for a specific entity and wildcard relation type
   * Returns an array of all matching relation instances
   * @param entityId The entity
   * @param componentType The wildcard relation type
   */
  getComponent<T>(entityId: EntityId, componentType: WildcardRelationId<T>): [EntityId<unknown>, any][] | undefined;
  /**
   * Get component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   */
  getComponent<T>(entityId: EntityId, componentType: EntityId<T>): T | undefined;
  getComponent<T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>): T | [EntityId<unknown>, any][] | undefined {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      if (getIdType(componentType) === "wildcard-relation") {
        return [];
      } else {
        return undefined;
      }
    }

    if (getIdType(componentType) === "wildcard-relation") {
      const decoded = decodeRelationId(componentType);
      const componentId = decoded.componentId;
      const relations: [EntityId<unknown>, any][] = [];

      for (const relType of this.componentTypes) {
        const relDecoded = decodeRelationId(relType);
        if (relDecoded.componentId === componentId && (getIdType(relType) === "entity-relation" || getIdType(relType) === "component-relation")) {
          const dataArray = this.componentData.get(relType);
          if (dataArray && dataArray[index] !== undefined) {
            relations.push([relDecoded.targetId, dataArray[index]]);
          }
        }
      }

      return relations;
    } else {
      return this.componentData.get(componentType)?.[index];
    }
  }

  /**
   * Set component data for a specific entity and component type
   * @param entityId The entity
   * @param componentType The component type
   * @param data The component data
   */
  setComponent<T>(entityId: EntityId, componentType: EntityId<T>, data: T): void {
    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }
    const dataArray = this.componentData.get(componentType);
    if (!dataArray) {
      throw new Error(`Component type ${componentType} is not in this archetype`);
    }
    dataArray[index] = data;
  }

  /**
   * Get all entities in this archetype
   */
  getEntities(): EntityId[] {
    return [...this.entities];
  }

  /**
   * Get component data for all entities of a specific component type
   * @param componentType The component type
   */
  getComponentData<T>(componentType: EntityId<T>): T[] {
    return [...(this.componentData.get(componentType) || [])];
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
        if (getIdType(compType) === "wildcard-relation") {
          // Decode the wildcard relation to get the component ID
          const decoded = decodeRelationId(compType);
          const componentId = decoded.componentId;

          // Find all concrete relation componentTypes in this archetype that match the wildcard
          const matchingRelations = this.componentTypes.filter((ct) => {
            const ctType = getIdType(ct);
            if (ctType !== "entity-relation" && ctType !== "component-relation") return false;
            const decodedCt = decodeRelationId(ct);
            return decodedCt.componentId === componentId;
          });

          return matchingRelations;
        } else {
          return this.componentData.get(compType)!; // Always exists for regular components
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
            const dataArray = this.componentData.get(relType);
            if (dataArray && dataArray[entityIndex] !== undefined) {
              const decodedRel = decodeRelationId(relType);
              relations.push([decodedRel.targetId, dataArray[entityIndex]]);
            }
          }
          return relations;
        } else {
          const dataArray = dataSource as any[];
          return dataArray ? dataArray[entityIndex] : undefined;
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
        components.set(componentType, this.componentData.get(componentType)![i]);
      }
      callback(this.entities[i]!, components);
    }
  }
}
