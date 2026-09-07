import type { Archetype } from "../archetype/archetype";
import { MISSING_COMPONENT } from "../archetype/archetype";
import type { SparseStore } from "../archetype/store";
import type { ComponentEntityStore } from "../component/entity-store";
import { shouldSkipSerialize } from "../component/registry";
import { getDetailedIdType, isComponentId, relation, type EntityId, type EntityIdManager } from "../entity";
import {
  decodeSerializedId,
  encodeEntityIdCached,
  isSerializedWorldV2,
  type SerializedArchetype,
  type SerializedColumn,
  type SerializedComponent,
  type SerializedEntity,
  type SerializedEntityId,
  type SerializedSparseRelationTable,
  type SerializedWorld,
  type SerializedWorldV1,
  type SerializedWorldV2,
} from "../storage/serialization";
import { trackEntityReference, type EntityReferencesMap } from "./references";

/** Snapshot layout produced by {@link serializeWorld}. */
export type SerializeFormat = "columnar" | "entities";

/** Options for {@link serializeWorld}. */
export interface SerializeWorldOptions {
  /**
   * When `true`, include components marked {@link ComponentOptions.skipSerialize}
   * (and relations whose base has that flag). Intended for debug dumps only
   * ({@link World.dump}); restore paths still drop these types via
   * {@link deserializeWorld}. Default `false` (save-game / network snapshot).
   */
  includeSkipSerialize?: boolean;
  /**
   * Snapshot layout. Default `"columnar"` ({@link SerializedWorldV2}).
   * `"entities"` emits the legacy {@link SerializedWorldV1} layout (kept for
   * benchmarks and as a reference implementation).
   */
  format?: SerializeFormat;
  /** Shared sparse relation store. Required for columnar sparse tables. */
  sparseStore?: SparseStore;
}

/**
 * Serializes the full world state to a plain JS object suitable for JSON encoding.
 *
 * By default, components registered with {@link ComponentOptions.skipSerialize}
 * (and relations whose base component has that flag) are omitted from the snapshot.
 * Pass `{ includeSkipSerialize: true }` for a debug dump that includes those types
 * (see {@link World.dump}). The same flag is consulted on deserialize
 * ({@link deserializeWorld}) so dirty or hand-written snapshots cannot reintroduce
 * skip-serialize types into a restored world.
 *
 * Default format is columnar (`version: 2`).
 */
export function serializeWorld(
  archetypes: Archetype[],
  componentEntities: ComponentEntityStore,
  entityIdManager: EntityIdManager,
  options?: SerializeWorldOptions,
): SerializedWorld {
  if (options?.format === "entities") {
    return serializeWorldEntities(archetypes, componentEntities, entityIdManager, options);
  }
  return serializeWorldColumnar(archetypes, componentEntities, entityIdManager, options);
}

function serializeWorldColumnar(
  archetypes: Archetype[],
  componentEntities: ComponentEntityStore,
  entityIdManager: EntityIdManager,
  options?: SerializeWorldOptions,
): SerializedWorldV2 {
  const includeSkipSerialize = options?.includeSkipSerialize === true;
  const idCache = new Map<EntityId<unknown>, SerializedEntityId>();
  const encode = (id: EntityId<unknown>): SerializedEntityId => encodeEntityIdCached(id, idCache);
  const skip = includeSkipSerialize ? undefined : shouldSkipSerialize;

  const serializedArchetypes: SerializedArchetype[] = [];
  for (const archetype of archetypes) {
    const encodedComponentTypes: (SerializedEntityId | null)[] = archetype.componentTypes.map((t) =>
      skip?.(t) ? null : encode(t),
    );
    const record = archetype.toSerializedArchetype(encode, encodedComponentTypes);
    if (record !== undefined) serializedArchetypes.push(record);
  }

  const sparseRelations = packSparseRelations(options?.sparseStore, encode, skip);
  const componentEntitiesArr = serializeComponentEntities(componentEntities, idCache, includeSkipSerialize);

  const snapshot: SerializedWorldV2 = {
    version: 2,
    entityManager: entityIdManager.serializeState(),
    archetypes: serializedArchetypes,
  };
  if (sparseRelations.length > 0) snapshot.sparseRelations = sparseRelations;
  if (componentEntitiesArr.length > 0) snapshot.componentEntities = componentEntitiesArr;
  return snapshot;
}

function serializeWorldEntities(
  archetypes: Archetype[],
  componentEntities: ComponentEntityStore,
  entityIdManager: EntityIdManager,
  options?: SerializeWorldOptions,
): SerializedWorldV1 {
  const includeSkipSerialize = options?.includeSkipSerialize === true;
  const idCache = new Map<EntityId<unknown>, SerializedEntityId>();

  const entities: SerializedEntity[] = [];
  for (const archetype of archetypes) {
    const encodedComponentTypes: (SerializedEntityId | null)[] = archetype.componentTypes.map((t) =>
      !includeSkipSerialize && shouldSkipSerialize(t) ? null : encodeEntityIdCached(t, idCache),
    );
    archetype.appendSerializedEntities(
      entities,
      (id) => encodeEntityIdCached(id, idCache),
      encodedComponentTypes,
      undefined,
      includeSkipSerialize ? undefined : shouldSkipSerialize,
    );
  }

  return {
    version: 1,
    entityManager: entityIdManager.serializeState(),
    entities,
    componentEntities: serializeComponentEntities(componentEntities, idCache, includeSkipSerialize),
  };
}

function serializeComponentEntities(
  componentEntities: ComponentEntityStore,
  idCache: Map<EntityId<unknown>, SerializedEntityId>,
  includeSkipSerialize: boolean,
): SerializedEntity[] {
  const componentEntitiesArr: SerializedEntity[] = [];
  for (const [entityId, components] of componentEntities.entries()) {
    componentEntitiesArr.push({
      id: encodeEntityIdCached(entityId, idCache),
      components: serializeComponentsFromMap(components, idCache, includeSkipSerialize),
    });
  }
  return componentEntitiesArr;
}

function packSparseRelations(
  sparseStore: SparseStore | undefined,
  encode: (id: EntityId<unknown>) => SerializedEntityId,
  skip: ((componentType: EntityId<unknown>) => boolean) | undefined,
): SerializedSparseRelationTable[] {
  if (sparseStore === undefined) return [];

  const grouped = new Map<
    EntityId<unknown>,
    { sources: SerializedEntityId[]; targets: SerializedEntityId[]; values: unknown[] }
  >();

  sparseStore.forEachEdge((componentId, entityId, _relationType, target, data) => {
    if (skip?.(componentId)) return;
    let table = grouped.get(componentId);
    if (table === undefined) {
      table = { sources: [], targets: [], values: [] };
      grouped.set(componentId, table);
    }
    table.sources.push(encode(entityId));
    table.targets.push(encode(target));
    table.values.push(data);
  });

  const result: SerializedSparseRelationTable[] = [];
  for (const [componentId, table] of grouped) {
    const packed: SerializedSparseRelationTable = {
      component: encode(componentId),
      sources: table.sources,
      targets: table.targets,
    };
    const values = packValueColumn(table.values);
    if (values !== null) packed.values = values;
    result.push(packed);
  }
  return result;
}

function packValueColumn(data: readonly unknown[]): SerializedColumn {
  const n = data.length;
  let undefCount = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] === undefined) undefCount++;
  }
  if (undefCount === n) return null;
  if (undefCount === 0) return data.slice();
  const v = new Array<unknown>(n);
  const u: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = data[i];
    if (x === undefined) {
      u.push(i);
      v[i] = null;
    } else {
      v[i] = x;
    }
  }
  return { v, u };
}

function unpackColumn(col: SerializedColumn | undefined): unknown[] | null {
  if (col === undefined || col === null) return null;
  if (Array.isArray(col)) return col;
  const v = col.v;
  for (let i = 0; i < col.u.length; i++) {
    v[col.u[i]!] = undefined;
  }
  return v;
}

function serializeComponentsFromMap(
  components: Map<EntityId<unknown>, unknown>,
  idCache: Map<EntityId<unknown>, SerializedEntityId>,
  includeSkipSerialize = false,
): SerializedComponent[] {
  const result: SerializedComponent[] = [];
  for (const [rawType, value] of components) {
    if (!includeSkipSerialize && shouldSkipSerialize(rawType)) continue;
    result.push({
      type: encodeEntityIdCached(rawType, idCache),
      value: value === MISSING_COMPONENT ? undefined : value,
    });
  }
  return result;
}

/**
 * Context needed by `deserializeWorld` to populate world-internal state.
 * Defined as an interface to avoid a circular import between world.ts and this module.
 */
export interface WorldDeserializationContext {
  entityIdManager: EntityIdManager;
  componentEntities: ComponentEntityStore;
  entityReferences: EntityReferencesMap;
  sparseStore: SparseStore;
  ensureArchetype(componentTypes: EntityId<unknown>[]): Archetype;
  setEntityToArchetype(entityId: EntityId, archetype: Archetype): void;
}

/**
 * Restores world state from a snapshot into the provided context.
 * Intended to be called from `World`'s constructor.
 *
 * Accepts both {@link SerializedWorldV2} (columnar, current) and
 * {@link SerializedWorldV1} (entity-oriented, legacy saves).
 *
 * Entries whose component type has {@link ComponentOptions.skipSerialize} in the
 * **current process registry** (via {@link shouldSkipSerialize}) are silently
 * dropped for both regular entities and component-entities, matching
 * {@link serializeWorld}. Entity existence is preserved even if every component
 * on that entity was skipped.
 */
export function deserializeWorld(ctx: WorldDeserializationContext, snapshot: SerializedWorld): void {
  if (snapshot.entityManager) {
    ctx.entityIdManager.deserializeState(snapshot.entityManager);
  }

  restoreComponentEntities(ctx, snapshot.componentEntities);

  if (isSerializedWorldV2(snapshot)) {
    deserializeColumnarEntities(ctx, snapshot);
    return;
  }
  deserializeEntityRecords(ctx, snapshot.entities);
}

function restoreComponentEntities(ctx: WorldDeserializationContext, entries: SerializedEntity[] | undefined): void {
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const entityId = decodeSerializedId(entry.id);
    if (!ctx.componentEntities.exists(entityId)) continue;

    const componentsArray: SerializedComponent[] = entry.components || [];
    const componentMap = new Map<EntityId<unknown>, unknown>();

    for (const componentEntry of componentsArray) {
      const componentType = decodeSerializedId(componentEntry.type);
      if (shouldSkipSerialize(componentType)) continue;
      componentMap.set(componentType, componentEntry.value);
    }

    ctx.componentEntities.initFromSnapshot(entityId, componentMap);
  }
}

function deserializeColumnarEntities(ctx: WorldDeserializationContext, snapshot: SerializedWorldV2): void {
  for (const record of snapshot.archetypes) {
    const n = record.entities.length;
    const types: EntityId<unknown>[] = [];
    const columns: (unknown[] | null)[] = [];

    for (let t = 0; t < record.types.length; t++) {
      const componentType = decodeSerializedId(record.types[t]!);
      if (shouldSkipSerialize(componentType)) continue;
      types.push(componentType);
      columns.push(unpackColumn(record.columns[t]));
    }

    const archetype = ctx.ensureArchetype(types);
    const entityIds = new Array<EntityId>(n);
    for (let i = 0; i < n; i++) {
      const entityId = decodeSerializedId(record.entities[i]!);
      entityIds[i] = entityId;
      ctx.setEntityToArchetype(entityId, archetype);
    }

    const aligned = alignColumnsToArchetype(archetype, types, columns);
    archetype.appendEntitiesFromColumns(entityIds, aligned);

    trackColumnReferences(ctx, entityIds, types);
  }

  restoreSparseRelations(ctx, snapshot.sparseRelations);
}

function alignColumnsToArchetype(
  archetype: Archetype,
  types: EntityId<unknown>[],
  columns: (unknown[] | null)[],
): (unknown[] | null)[] {
  if (types.length === archetype.componentTypes.length) {
    let sameOrder = true;
    for (let i = 0; i < types.length; i++) {
      if (types[i] !== archetype.componentTypes[i]) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) return columns;
  }

  const byType = new Map<EntityId<unknown>, unknown[] | null>();
  for (let i = 0; i < types.length; i++) {
    byType.set(types[i]!, columns[i]!);
  }
  return archetype.componentTypes.map((type) => byType.get(type) ?? null);
}

function trackColumnReferences(
  ctx: WorldDeserializationContext,
  entityIds: EntityId[],
  types: EntityId<unknown>[],
): void {
  for (const componentType of types) {
    const detailedType = getDetailedIdType(componentType);
    if (detailedType.type === "entity-relation") {
      const targetId = detailedType.targetId;
      for (let i = 0; i < entityIds.length; i++) {
        trackEntityReference(ctx.entityReferences, entityIds[i]!, componentType, targetId);
      }
    } else if (detailedType.type === "entity") {
      for (let i = 0; i < entityIds.length; i++) {
        trackEntityReference(ctx.entityReferences, entityIds[i]!, componentType, componentType);
      }
    }
  }
}

function restoreSparseRelations(
  ctx: WorldDeserializationContext,
  tables: SerializedSparseRelationTable[] | undefined,
): void {
  if (!Array.isArray(tables)) return;

  for (const table of tables) {
    const componentId = decodeSerializedId(table.component);
    if (!isComponentId(componentId) || shouldSkipSerialize(componentId)) continue;

    const n = table.sources.length;
    const values = unpackColumn(table.values);
    for (let i = 0; i < n; i++) {
      const source = decodeSerializedId(table.sources[i]!);
      const target = decodeSerializedId(table.targets[i]!);
      const rel = relation(componentId, target);
      const value = values === null ? undefined : values[i];
      ctx.sparseStore.setValue(source, rel, value);

      const detailedType = getDetailedIdType(rel);
      if (detailedType.type === "entity-relation") {
        trackEntityReference(ctx.entityReferences, source, rel, detailedType.targetId);
      } else if (detailedType.type === "entity") {
        trackEntityReference(ctx.entityReferences, source, rel, rel);
      }
    }
  }
}

function deserializeEntityRecords(ctx: WorldDeserializationContext, entities: SerializedEntity[] | undefined): void {
  if (!Array.isArray(entities)) return;

  const componentMap = new Map<EntityId<unknown>, unknown>();
  const archetypeCache = new Map<string, Archetype>();

  for (const entry of entities) {
    const entityId = decodeSerializedId(entry.id);
    const componentsArray: SerializedComponent[] = entry.components || [];

    componentMap.clear();
    for (const componentEntry of componentsArray) {
      const componentType = decodeSerializedId(componentEntry.type);
      if (shouldSkipSerialize(componentType)) continue;
      componentMap.set(componentType, componentEntry.value);
    }

    const signatureParts: number[] = [];
    for (const compType of componentMap.keys()) {
      signatureParts.push(compType as number);
    }
    signatureParts.sort((a, b) => a - b);
    const signature = signatureParts.join(",");

    let archetype = archetypeCache.get(signature);
    if (archetype === undefined) {
      archetype = ctx.ensureArchetype(Array.from(componentMap.keys()));
      archetypeCache.set(signature, archetype);
    }

    archetype.addEntity(entityId, componentMap);
    ctx.setEntityToArchetype(entityId, archetype);

    for (const compType of componentMap.keys()) {
      const detailedType = getDetailedIdType(compType);
      if (detailedType.type === "entity-relation") {
        trackEntityReference(ctx.entityReferences, entityId, compType, detailedType.targetId);
      } else if (detailedType.type === "entity") {
        trackEntityReference(ctx.entityReferences, entityId, compType, compType);
      }
    }
  }
}
