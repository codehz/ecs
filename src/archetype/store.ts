import type { EntityId } from "../entity";
import { getComponentIdFromRelationId, getTargetIdFromRelationId } from "../entity";

/**
 * Internal representation for the relations an entity has under one component kind.
 * 'single' is the optimized form for exclusive relations (vast majority of cases).
 */
type RelationEntry =
  | { type: "single"; relationType: EntityId<any>; target: EntityId; data: any }
  | { type: "multi"; targets: Map<EntityId, { relationType: EntityId<any>; data: any }> };

/**
 * Interface for the sparse side store used by components declared with `sparse: true`
 * (or the legacy `dontFragment: true` alias).
 *
 * Relation data for these components lives here instead of in archetype columns,
 * preventing fragmentation for high-cardinality or frequently-changing relations.
 *
 * Storage is primarily keyed by base relation ComponentId. This enables efficient
 * per-component lookups required by wildcard queries (relation(Comp, "*")) and
 * archetype filtering, while still supporting full-entity enumeration when needed.
 */
export interface SparseStore {
  // High-frequency per-(entity, relation) operations (get/set/has/remove, structural changes)
  getValue(entityId: EntityId, relationType: EntityId<any>): any | undefined;
  setValue(entityId: EntityId, relationType: EntityId<any>, data: any): void;
  deleteValue(entityId: EntityId, relationType: EntityId<any>): boolean;

  // Hot paths for wildcard queries and archetype filtering (per-component lookups)
  hasAnyForComponent(componentId: EntityId<any>): boolean;
  getRelationsForComponent(entityId: EntityId, componentId: EntityId<any>): [target: EntityId, data: any][];

  // Entity-wide enumeration paths (used for snapshots, serialization, forEach, and rare presence checks)
  getAllForEntity(entityId: EntityId): Array<[relationType: EntityId<any>, data: any]>;
  deleteEntity(entityId: EntityId): void;

  /**
   * @internal Bulk helper for serialization of many entities.
   * Default implementation simply loops getAllForEntity; subclasses / future
   * implementations can provide a more efficient fused walk.
   */
  getAllForEntities(entityIds: readonly EntityId[]): Map<EntityId, Array<[EntityId<any>, any]>>;
}

/**
 * Production implementation of SparseStore.
 *
 * Internal layout (optimized):
 * - byComponent: baseComponentId → (entityId → RelationEntry)
 *   RelationEntry uses a single-value form for the common exclusive case (1 target),
 *   avoiding Map allocation for the vast majority of usage.
 * - entityIndex: entityId → Set<baseComponentId>
 *   Lightweight reverse index.
 */
export class SparseStoreImpl implements SparseStore {
  /**
   * Primary storage, keyed by the base relation component ID.
   */
  private byComponent = new Map<
    EntityId<any>, // base componentId
    Map<EntityId, RelationEntry>
  >();

  /**
   * Reverse index: which base component kinds an entity participates in.
   * Only required to support getAllForEntity and deleteEntity efficiently.
   * The primary storage (byComponent) is deliberately not optimized for these operations.
   */
  private entityIndex = new Map<EntityId, Set<EntityId<any>>>();

  getValue(entityId: EntityId, relationType: EntityId<any>): any | undefined {
    const componentId = getComponentIdFromRelationId(relationType);
    if (componentId === undefined) return undefined;

    const entities = this.byComponent.get(componentId);
    if (!entities) return undefined;

    const entry = entities.get(entityId);
    if (!entry) return undefined;

    const targetId = getTargetIdFromRelationId(relationType)!;

    if (entry.type === "single") {
      return entry.target === targetId ? entry.data : undefined;
    } else {
      const item = entry.targets.get(targetId);
      return item ? item.data : undefined;
    }
  }

  setValue(entityId: EntityId, relationType: EntityId<any>, data: any): void {
    const componentId = getComponentIdFromRelationId(relationType);
    if (componentId === undefined) {
      throw new Error("setValue called with a non-relation type on SparseStore");
    }

    let entities = this.byComponent.get(componentId);
    if (!entities) {
      entities = new Map();
      this.byComponent.set(componentId, entities);
    }

    const targetId = getTargetIdFromRelationId(relationType)!;
    let entry = entities.get(entityId);

    if (!entry) {
      // First relation for this (entity, component) — use single form (big win for exclusive)
      entry = { type: "single", relationType, target: targetId, data };
      entities.set(entityId, entry);
    } else if (entry.type === "single") {
      if (entry.target === targetId) {
        entry.data = data;
        entry.relationType = relationType; // update in case it changed
      } else {
        // Promote to multi
        const targets = new Map();
        targets.set(entry.target, { relationType: entry.relationType, data: entry.data });
        targets.set(targetId, { relationType, data });
        entities.set(entityId, { type: "multi", targets });
      }
    } else {
      entry.targets.set(targetId, { relationType, data });
    }

    // Maintain reverse index
    let components = this.entityIndex.get(entityId);
    if (!components) {
      components = new Set();
      this.entityIndex.set(entityId, components);
    }
    components.add(componentId);
  }

  deleteValue(entityId: EntityId, relationType: EntityId<any>): boolean {
    const componentId = getComponentIdFromRelationId(relationType);
    if (componentId === undefined) return false;

    const entities = this.byComponent.get(componentId);
    if (!entities) return false;

    const entry = entities.get(entityId);
    if (!entry) return false;

    const targetId = getTargetIdFromRelationId(relationType)!;
    let existed = false;

    if (entry.type === "single") {
      if (entry.target === targetId) {
        existed = true;
        entities.delete(entityId);
      }
    } else {
      existed = entry.targets.delete(targetId);
      if (entry.targets.size === 0) {
        entities.delete(entityId);
      } else if (entry.targets.size === 1) {
        // Demote to single
        const [first] = entry.targets.entries();
        const [t, item] = first!;
        entities.set(entityId, { type: "single", relationType: item.relationType, target: t, data: item.data });
      }
    }

    if (!entities.has(entityId) && entities.size === 0) {
      this.byComponent.delete(componentId);
    }

    // Update reverse index
    const components = this.entityIndex.get(entityId);
    if (components && !entities.has(entityId)) {
      components.delete(componentId);
      if (components.size === 0) {
        this.entityIndex.delete(entityId);
      }
    }

    return existed;
  }

  hasAnyForComponent(componentId: EntityId<any>): boolean {
    const entities = this.byComponent.get(componentId);
    return entities !== undefined && entities.size > 0;
  }

  getRelationsForComponent(entityId: EntityId, componentId: EntityId<any>): [EntityId, any][] {
    const result: [EntityId, any][] = [];

    const entities = this.byComponent.get(componentId);
    if (!entities) return result;

    const entry = entities.get(entityId);
    if (!entry) return result;

    if (entry.type === "single") {
      result.push([entry.target, entry.data]);
    } else {
      for (const [target, item] of entry.targets) {
        result.push([target, item.data]);
      }
    }

    return result;
  }

  getAllForEntity(entityId: EntityId): Array<[relationType: EntityId<any>, data: any]> {
    const components = this.entityIndex.get(entityId);
    if (!components || components.size === 0) return [];

    const result: Array<[EntityId<any>, any]> = [];

    for (const componentId of components) {
      const entities = this.byComponent.get(componentId);
      const entry = entities?.get(entityId);
      if (entry) {
        if (entry.type === "single") {
          result.push([entry.relationType, entry.data]);
        } else {
          for (const item of entry.targets.values()) {
            result.push([item.relationType, item.data]);
          }
        }
      }
    }

    return result;
  }

  deleteEntity(entityId: EntityId): void {
    const components = this.entityIndex.get(entityId);
    if (!components) return;

    for (const componentId of components) {
      const entities = this.byComponent.get(componentId);
      if (entities) {
        entities.delete(entityId);
        if (entities.size === 0) {
          this.byComponent.delete(componentId);
        }
      }
    }

    this.entityIndex.delete(entityId);
  }

  getAllForEntities(entityIds: readonly EntityId[]): Map<EntityId, Array<[EntityId<any>, any]>> {
    const result = new Map<EntityId, Array<[EntityId<any>, any]>>();
    for (const eid of entityIds) {
      const data = this.getAllForEntity(eid);
      if (data.length > 0) {
        result.set(eid, data);
      }
    }
    return result;
  }
}
