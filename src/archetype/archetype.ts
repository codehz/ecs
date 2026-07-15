import { normalizeComponentTypes } from "../component/type-utils";
import type { EntityId, WildcardRelationId } from "../entity";
import {
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  isSparseComponent,
  isSparseRelation,
  isWildcardRelationId,
} from "../entity";
import type { SerializedComponent, SerializedEntity, SerializedEntityId } from "../storage/serialization";
import { isOptionalEntityId, type ComponentTuple, type ComponentType, type LifecycleHookEntry } from "../types";
import { getOrCompute } from "../utils/utils";
import { buildCacheKey, buildSingleComponent, getWildcardRelationDataSource, isRelationType } from "./helpers";
import type { SparseStore } from "./store";

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
   * SparseStore used for relations declared with `sparse: true`.
   * See store.ts for implementation details.
   */
  private sparseRelations: SparseStore;

  /**
   * Multi-hooks that match this archetype
   */
  public readonly matchingMultiHooks: Set<LifecycleHookEntry> = new Set();

  /**
   * Cache for pre-computed component data sources to avoid repeated calculations
   */
  private componentDataSourcesCache: Map<string, (any[] | EntityId<any>[] | undefined)[]> = new Map();

  constructor(componentTypes: EntityId<any>[], sparseStore: SparseStore) {
    this.componentTypes = normalizeComponentTypes(componentTypes);
    this.componentTypeSet = new Set(this.componentTypes);
    this.sparseRelations = sparseStore;

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

    // Add sparse-stored relations separately
    this.addSparseRelations(entityId, componentData);
  }

  private addSparseRelations(entityId: EntityId, componentData: Map<EntityId<any>, any>): void {
    for (const [componentType, data] of componentData) {
      if (this.componentTypeSet.has(componentType)) continue;

      const detailedType = getDetailedIdType(componentType);
      if (isRelationType(detailedType) && isSparseComponent(detailedType.componentId!)) {
        this.sparseRelations.setValue(entityId, componentType, data);
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

    // Add sparse-stored relations
    const sparseTuples = this.sparseRelations.getAllForEntity(entityId);
    for (const [componentType, data] of sparseTuples) {
      entityData.set(componentType, data);
    }

    return entityData;
  }

  /**
   * Returns all sparse-stored relations for the given entity.
   * Internal helper used by command processing and tests.
   * Prefer {@link forEachSparseRelationTypeOfComponent} on hot exclusive paths.
   */
  getEntitySparseRelations(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    const tuples = this.sparseRelations.getAllForEntity(entityId);
    if (tuples.length === 0) return undefined;

    const map = new Map<EntityId<any>, any>();
    for (const [relType, data] of tuples) {
      map.set(relType, data);
    }
    return map;
  }

  /**
   * Enumerate sparse relation types of a single base component for an entity.
   * Used by exclusive-relation matching without allocating intermediate Maps.
   */
  forEachSparseRelationTypeOfComponent(
    entityId: EntityId,
    componentId: EntityId<any>,
    callback: (relationType: EntityId<any>) => void,
  ): void {
    this.sparseRelations.forEachRelationTypeOfComponent(entityId, componentId, callback);
  }

  /** True if the entity has any sparse relation of the given base component. */
  hasSparseRelationOfComponent(entityId: EntityId, componentId: EntityId<any>): boolean {
    return this.sparseRelations.hasRelationOfComponent(entityId, componentId);
  }

  dump(): Array<{ entity: EntityId; components: Map<EntityId<any>, any> }> {
    return this.entities.map((entity, i) => {
      const components = new Map<EntityId<any>, any>();

      for (const componentType of this.componentTypes) {
        const data = this.getComponentData(componentType)[i];
        components.set(componentType, data === MISSING_COMPONENT ? undefined : data);
      }

      const sparseTuples = this.sparseRelations.getAllForEntity(entity);
      for (const [componentType, data] of sparseTuples) {
        components.set(componentType, data);
      }

      return { entity, components };
    });
  }

  /**
   * @internal Serialization fast-path.
   *
   * Appends SerializedEntity records directly from the archetype's column storage
   * (componentData arrays) plus sparse relations, avoiding per-entity Map
   * allocation and repeated Array.from(entries()).
   *
   * Component type IDs should be pre-encoded by the caller (once per archetype)
   * and passed in `encodedComponentTypes` (same order and length as this.componentTypes).
   *
   * The provided `encode` function should be the cached variant for best performance
   * on entity IDs and any sparse relation type IDs.
   *
   * `sparseByEntity` is an optional pre-fetched map from a bulk
   * `SparseStore.getAllForEntities` call (further reduces per-entity calls).
   */
  appendSerializedEntities(
    out: SerializedEntity[],
    encode: (id: EntityId<any>) => SerializedEntityId,
    encodedComponentTypes: (SerializedEntityId | null)[],
    sparseByEntity?: Map<EntityId, Array<[EntityId<any>, any]>>,
    shouldSkip?: (componentType: EntityId<any>) => boolean,
  ): void {
    if (encodedComponentTypes.length !== this.componentTypes.length) {
      throw new Error("encodedComponentTypes length must match archetype componentTypes");
    }

    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i]!;

      const components: SerializedComponent[] = [];
      // Regular (non-sparse) components from column arrays
      for (let c = 0; c < this.componentTypes.length; c++) {
        // null marker: component type is skipSerialize — omit from snapshot
        const encodedType = encodedComponentTypes[c];
        if (encodedType == null) continue;
        const data = this.getComponentData(this.componentTypes[c]!)[i];
        components.push({
          type: encodedType,
          value: data === MISSING_COMPONENT ? undefined : data,
        });
      }

      // Append any sparse relations for this entity (usually small or zero)
      const sparseTuples = sparseByEntity?.get(entity) ?? this.sparseRelations.getAllForEntity(entity);
      for (const [componentType, data] of sparseTuples) {
        if (shouldSkip?.(componentType)) continue;
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

    // Include sparse relations
    const sparseTuples = this.sparseRelations.getAllForEntity(entityId);
    for (const [componentType, data] of sparseTuples) {
      removedData.set(componentType, data);
    }
    this.sparseRelations.deleteEntity(entityId);

    this.swapRemoveAt(index, entityId);
    return removedData;
  }

  /**
   * Hot-path archetype migration: copy columns directly into `target` and apply
   * the structural changeset without allocating an intermediate per-entity Map.
   *
   * Sparse relations live in a shared store, so only removed/added sparse edges
   * are touched — surviving relations stay in place.
   *
   * @param removedOut When non-null, records values of components being removed (for lifecycle hooks).
   */
  migrateEntityTo(
    target: Archetype,
    entityId: EntityId,
    adds: ReadonlyMap<EntityId<any>, any>,
    removes: ReadonlySet<EntityId<any>>,
    removedOut: Map<EntityId<any>, any> | null,
  ): void {
    if (target === this) {
      throw new Error("migrateEntityTo requires a different target archetype");
    }
    if (target.entityToIndex.has(entityId)) {
      throw new Error(`Entity ${entityId} is already in the target archetype`);
    }

    const index = this.entityToIndex.get(entityId);
    if (index === undefined) {
      throw new Error(`Entity ${entityId} is not in this archetype`);
    }

    // Capture removed regular-column values for hooks before swap-remove.
    if (removedOut !== null) {
      for (const componentType of removes) {
        if (this.componentTypeSet.has(componentType)) {
          const data = this.getComponentData(componentType)[index];
          removedOut.set(componentType, data === MISSING_COMPONENT ? undefined : data);
        } else if (isSparseRelation(componentType)) {
          // Presence is independent of payload (void tags store undefined).
          if (this.sparseRelations.hasValue(entityId, componentType)) {
            removedOut.set(componentType, this.sparseRelations.getValue(entityId, componentType));
          }
        }
      }
    }

    // Apply sparse removes / adds on the shared store (do NOT wipe surviving sparse edges).
    for (const componentType of removes) {
      if (isSparseRelation(componentType)) {
        this.sparseRelations.deleteValue(entityId, componentType);
      }
    }
    for (const [componentType, data] of adds) {
      if (isSparseRelation(componentType)) {
        this.sparseRelations.setValue(entityId, componentType, data);
      }
    }

    // Push entity into target columns: shared columns copy, new columns take add payload.
    const targetIndex = target.entities.length;
    target.entities.push(entityId);
    target.entityToIndex.set(entityId, targetIndex);

    for (const componentType of target.componentTypes) {
      const column = target.getComponentData(componentType);
      if (adds.has(componentType) && !isSparseRelation(componentType)) {
        column.push(adds.get(componentType));
      } else if (this.componentTypeSet.has(componentType)) {
        column.push(this.getComponentData(componentType)[index]);
      } else {
        // Should not happen for well-formed migrations; keep storage consistent.
        column.push(MISSING_COMPONENT);
      }
    }

    // Drop entity from this archetype (columns only — sparse already handled above).
    this.swapRemoveAt(index, entityId);
  }

  /** Swap-and-pop entity at `index` without touching sparse storage. */
  private swapRemoveAt(index: number, entityId: EntityId): void {
    this.entityToIndex.delete(entityId);

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

    // Check regular archetype columns.
    // Presence is "type is on this archetype", not "payload !== undefined":
    // void/tag relations store `undefined` as a legitimate value.
    // Align with buildWildcardRelationValue in helpers.ts.
    for (const relType of this.componentTypes) {
      const relDetailed = getDetailedIdType(relType);
      if (isRelationType(relDetailed) && relDetailed.componentId === componentId) {
        const data = this.getComponentData(relType)[index];
        relations.push([relDetailed.targetId, data === MISSING_COMPONENT ? undefined : data]);
      }
    }

    // Check sparse relations (now uses the efficient per-component path)
    if (componentId !== undefined) {
      const matches = this.sparseRelations.getRelationsForComponent(entityId, componentId);
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

    if (this.sparseRelations.hasValue(entityId, componentType)) {
      return this.sparseRelations.getValue(entityId, componentType);
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

    if (this.sparseRelations.hasValue(entityId, componentType)) {
      return { value: this.sparseRelations.getValue(entityId, componentType) };
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
    if (isRelationType(detailedType) && isSparseComponent(detailedType.componentId!)) {
      this.sparseRelations.setValue(entityId, componentType, data);
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

    // Specific sparse relations are stored in SparseStore, not archetype columns.
    // Return undefined as a sentinel; buildSingleComponent reads SparseStore by entity.
    if (isSparseRelation(actualType)) {
      return undefined;
    }

    return optional ? this.getOptionalComponentData(actualType) : this.getComponentData(actualType);
  }

  private buildComponentsForIndex<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    componentDataSources: (any[] | EntityId<any>[] | undefined)[],
    entityIndex: number,
    entityId: EntityId,
    out?: any[],
  ): ComponentTuple<T> {
    const len = componentTypes.length;
    const result = out ?? new Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = buildSingleComponent(
        componentTypes[i]!,
        componentDataSources[i],
        entityIndex,
        entityId,
        (type) => this.getComponentData(type),
        this.sparseRelations,
      );
    }
    return result as ComponentTuple<T>;
  }

  /**
   * True when every requested component is a plain column (no optional / wildcard / sparse-specific).
   * Enables the zero-allocation forEach hot path used by typical game systems.
   */
  private isSimpleColumnQuery(componentTypes: readonly ComponentType<any>[]): boolean {
    for (let i = 0; i < componentTypes.length; i++) {
      const compType = componentTypes[i]!;
      if (isOptionalEntityId(compType)) return false;
      if (getIdType(compType) === "wildcard-relation") return false;
      if (isSparseRelation(compType)) return false;
    }
    return true;
  }

  private readSimpleColumnValue(column: any[] | undefined, entityIndex: number, componentType: EntityId<any>): any {
    if (column === undefined) {
      throw new Error(`Component data not found for mandatory component type ${componentType}`);
    }
    const data = column[entityIndex];
    if (data === MISSING_COMPONENT) {
      throw new Error(`Component type ${componentType} not found at index ${entityIndex}`);
    }
    return data;
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
    entityFilter?: (entity: EntityId) => boolean,
  ): void {
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;
      if (entityFilter && !entityFilter(entity)) continue;
      // Fresh array per entity — callers own the returned component tuples.
      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);
      result.push({ entity, components });
    }
  }

  *iterateWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    entityFilter?: (entity: EntityId) => boolean,
  ): IterableIterator<[EntityId, ...ComponentTuple<T>]> {
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);

    for (let entityIndex = 0; entityIndex < this.entities.length; entityIndex++) {
      const entity = this.entities[entityIndex]!;
      if (entityFilter && !entityFilter(entity)) continue;
      // Generator yields owned tuples; allocate per entity (cannot reuse across yields).
      const components = this.buildComponentsForIndex(componentTypes, componentDataSources, entityIndex, entity);
      yield [entity, ...components];
    }
  }

  forEachWithComponents<const T extends readonly ComponentType<any>[]>(
    componentTypes: T,
    callback: (entity: EntityId, ...components: ComponentTuple<T>) => void,
    entityFilter?: (entity: EntityId) => boolean,
  ): void {
    const componentDataSources = this.getCachedComponentDataSources(componentTypes);
    const len = componentTypes.length;
    const entities = this.entities;
    const entityCount = entities.length;
    const cb = callback as (entity: EntityId, ...components: any[]) => void;

    // Hot path: plain column components (Position/Velocity style systems).
    // Avoids per-entity Array allocation and rest-parameter packing.
    if (this.isSimpleColumnQuery(componentTypes)) {
      if (len === 1) {
        const col0 = componentDataSources[0] as any[] | undefined;
        const t0 = componentTypes[0] as EntityId<any>;
        for (let i = 0; i < entityCount; i++) {
          const entity = entities[i]!;
          if (entityFilter && !entityFilter(entity)) continue;
          cb(entity, this.readSimpleColumnValue(col0, i, t0));
        }
        return;
      }
      if (len === 2) {
        const col0 = componentDataSources[0] as any[] | undefined;
        const col1 = componentDataSources[1] as any[] | undefined;
        const t0 = componentTypes[0] as EntityId<any>;
        const t1 = componentTypes[1] as EntityId<any>;
        for (let i = 0; i < entityCount; i++) {
          const entity = entities[i]!;
          if (entityFilter && !entityFilter(entity)) continue;
          cb(entity, this.readSimpleColumnValue(col0, i, t0), this.readSimpleColumnValue(col1, i, t1));
        }
        return;
      }
      if (len === 3) {
        const col0 = componentDataSources[0] as any[] | undefined;
        const col1 = componentDataSources[1] as any[] | undefined;
        const col2 = componentDataSources[2] as any[] | undefined;
        const t0 = componentTypes[0] as EntityId<any>;
        const t1 = componentTypes[1] as EntityId<any>;
        const t2 = componentTypes[2] as EntityId<any>;
        for (let i = 0; i < entityCount; i++) {
          const entity = entities[i]!;
          if (entityFilter && !entityFilter(entity)) continue;
          cb(
            entity,
            this.readSimpleColumnValue(col0, i, t0),
            this.readSimpleColumnValue(col1, i, t1),
            this.readSimpleColumnValue(col2, i, t2),
          );
        }
        return;
      }
      if (len === 4) {
        const col0 = componentDataSources[0] as any[] | undefined;
        const col1 = componentDataSources[1] as any[] | undefined;
        const col2 = componentDataSources[2] as any[] | undefined;
        const col3 = componentDataSources[3] as any[] | undefined;
        const t0 = componentTypes[0] as EntityId<any>;
        const t1 = componentTypes[1] as EntityId<any>;
        const t2 = componentTypes[2] as EntityId<any>;
        const t3 = componentTypes[3] as EntityId<any>;
        for (let i = 0; i < entityCount; i++) {
          const entity = entities[i]!;
          if (entityFilter && !entityFilter(entity)) continue;
          cb(
            entity,
            this.readSimpleColumnValue(col0, i, t0),
            this.readSimpleColumnValue(col1, i, t1),
            this.readSimpleColumnValue(col2, i, t2),
            this.readSimpleColumnValue(col3, i, t3),
          );
        }
        return;
      }
    }

    // General path: optional / wildcard / sparse-specific / N>4.
    // Unroll common arities so we still avoid allocating a temporary components array.
    const getData = (type: EntityId<any>) => this.getComponentData(type);
    const sparse = this.sparseRelations;

    if (len === 1) {
      for (let i = 0; i < entityCount; i++) {
        const entity = entities[i]!;
        if (entityFilter && !entityFilter(entity)) continue;
        cb(entity, buildSingleComponent(componentTypes[0]!, componentDataSources[0], i, entity, getData, sparse));
      }
      return;
    }
    if (len === 2) {
      for (let i = 0; i < entityCount; i++) {
        const entity = entities[i]!;
        if (entityFilter && !entityFilter(entity)) continue;
        cb(
          entity,
          buildSingleComponent(componentTypes[0]!, componentDataSources[0], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[1]!, componentDataSources[1], i, entity, getData, sparse),
        );
      }
      return;
    }
    if (len === 3) {
      for (let i = 0; i < entityCount; i++) {
        const entity = entities[i]!;
        if (entityFilter && !entityFilter(entity)) continue;
        cb(
          entity,
          buildSingleComponent(componentTypes[0]!, componentDataSources[0], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[1]!, componentDataSources[1], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[2]!, componentDataSources[2], i, entity, getData, sparse),
        );
      }
      return;
    }
    if (len === 4) {
      for (let i = 0; i < entityCount; i++) {
        const entity = entities[i]!;
        if (entityFilter && !entityFilter(entity)) continue;
        cb(
          entity,
          buildSingleComponent(componentTypes[0]!, componentDataSources[0], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[1]!, componentDataSources[1], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[2]!, componentDataSources[2], i, entity, getData, sparse),
          buildSingleComponent(componentTypes[3]!, componentDataSources[3], i, entity, getData, sparse),
        );
      }
      return;
    }

    // N>4 fallback: reuse one scratch buffer for the duration of the loop.
    // Callers must not retain the rest-args array across iterations (same as before).
    const scratch: any[] = new Array(len);
    for (let i = 0; i < entityCount; i++) {
      const entity = entities[i]!;
      if (entityFilter && !entityFilter(entity)) continue;
      this.buildComponentsForIndex(componentTypes, componentDataSources, i, entity, scratch);
      cb(entity, ...scratch);
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

      // Append sparse relations (entity-wide enumeration; acceptable cost for forEach)
      const sparseTuples = this.sparseRelations.getAllForEntity(entity);
      for (const [componentType, data] of sparseTuples) {
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

    // Check sparse relations only for entities that actually belong to *this* archetype.
    // We must not use the global hasAnyForComponent here, otherwise unrelated archetypes
    // can be incorrectly pulled into wildcard queries when any entity in the world has the relation.
    for (const entityId of this.entities) {
      const rels = this.sparseRelations.getRelationsForComponent(entityId, componentId);
      if (rels.length > 0) {
        return true;
      }
    }
    return false;
  }
}
