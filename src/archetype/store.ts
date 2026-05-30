import type { EntityId } from "../entity";
import { getComponentIdFromRelationId, getTargetIdFromRelationId } from "../entity";

/**
 * Interface for storing dontFragment relation data.
 *
 * Storage is now primarily keyed by relation ComponentId (the "kind" of relation)
 * rather than by entity. This provides O(1) or near-O(1) answers for the hot
 * wildcard-related paths (hasRelationWithComponentId, wildcard materialization
 * during iteration, hook matching, etc.).
 *
 * A lightweight reverse index (entity -> Set of base ComponentIds) is maintained
 * to efficiently support the infrequent "get all dontFragment data for this entity"
 * operations (removeEntity, dump, getEntity, serialization).
 *
 * The interface no longer leaks internal Map structures. Callers work with
 * semantic operations only.
 */
export interface DontFragmentStore {
  // High-frequency operations (used by get/set/getOptional and structural changes)
  getValue(entityId: EntityId, relationType: EntityId<any>): any | undefined;
  setValue(entityId: EntityId, relationType: EntityId<any>, data: any): void;
  deleteValue(entityId: EntityId, relationType: EntityId<any>): boolean;

  // Wildcard / filtering hot paths (X-class priority)
  hasAnyForComponent(componentId: EntityId<any>): boolean;
  getRelationsForComponent(entityId: EntityId, componentId: EntityId<any>): [target: EntityId, data: any][];

  // Low-frequency "get everything for entity" paths (Y-class, acceptable cost)
  getAllForEntity(entityId: EntityId): Array<[relationType: EntityId<any>, data: any]>;
  deleteEntity(entityId: EntityId): void;
}

/**
 * Production implementation of DontFragmentStore.
 *
 * Internal layout:
 * - byComponent: baseComponentId → (entityId → Map<fullRelationType, data>)
 *   This makes "all relations of kind X" extremely cheap.
 * - entityIndex: entityId → Set<baseComponentId>
 *   Lightweight reverse index (usually 0 or 1 entries per entity for exclusive relations).
 *
 * TODO (performance, post-MVP):
 *   For exclusive dontFragment relations (the common case, e.g. ChildOf with exclusive: true),
 *   replace the innermost `Map<fullRelationType, data>` (or Map<target, data>) with a
 *   zero-allocation single-value representation:
 *     { type: 'single', target: EntityId, data: any }
 *   This eliminates the per-entity Map allocation for 99% of dontFragment usage and
 *   further reduces GC pressure on structural changes.
 *
 * TODO (performance, post-MVP):
 *   Add a batch-oriented method for archetype iteration hot paths, e.g.:
 *     getRelationsForEntities(componentId, entities: EntityId[]):
 *       Map<EntityId, [target, data][]>
 *   This can avoid repeated Map lookups + decoding when forEachWithComponents
 *   processes hundreds or thousands of entities with the same wildcard component.
 */
export class DontFragmentStoreImpl implements DontFragmentStore {
  /**
   * Primary storage, keyed by the base relation component ID.
   * Inner map: entity → (full encoded relation ID → user data)
   */
  private byComponent = new Map<
    EntityId<any>, // base componentId
    Map<EntityId, Map<EntityId<any>, any>> // entity → fullRelType → data
  >();

  /**
   * Reverse index: which base component kinds an entity participates in.
   * Used only by the infrequent getAllForEntity / deleteEntity paths.
   */
  private entityIndex = new Map<EntityId, Set<EntityId<any>>>();

  getValue(entityId: EntityId, relationType: EntityId<any>): any | undefined {
    const componentId = getComponentIdFromRelationId(relationType);
    if (componentId === undefined) return undefined;

    const entities = this.byComponent.get(componentId);
    if (!entities) return undefined;

    const relsForEntity = entities.get(entityId);
    if (!relsForEntity) return undefined;

    return relsForEntity.get(relationType);
  }

  setValue(entityId: EntityId, relationType: EntityId<any>, data: any): void {
    const componentId = getComponentIdFromRelationId(relationType);
    if (componentId === undefined) {
      throw new Error("setValue called with a non-relation type on DontFragmentStore");
    }

    let entities = this.byComponent.get(componentId);
    if (!entities) {
      entities = new Map();
      this.byComponent.set(componentId, entities);
    }

    let relsForEntity = entities.get(entityId);
    if (!relsForEntity) {
      relsForEntity = new Map();
      entities.set(entityId, relsForEntity);
    }

    relsForEntity.set(relationType, data);

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

    const relsForEntity = entities.get(entityId);
    if (!relsForEntity) return false;

    const existed = relsForEntity.delete(relationType);

    // Clean up empty inner structures
    if (relsForEntity.size === 0) {
      entities.delete(entityId);
    }
    if (entities.size === 0) {
      this.byComponent.delete(componentId);
    }

    // Update reverse index
    const components = this.entityIndex.get(entityId);
    if (components) {
      // Only remove the componentId if this entity no longer has ANY relations under it
      let stillHasThisComponent = false;
      const remaining = entities.get(entityId);
      if (remaining) {
        for (const rel of remaining.keys()) {
          if (getComponentIdFromRelationId(rel) === componentId) {
            stillHasThisComponent = true;
            break;
          }
        }
      }
      if (!stillHasThisComponent) {
        components.delete(componentId);
        if (components.size === 0) {
          this.entityIndex.delete(entityId);
        }
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

    const relsForEntity = entities.get(entityId);
    if (!relsForEntity) return result;

    for (const [relType, data] of relsForEntity) {
      const targetId = getTargetIdFromRelationId(relType);
      if (targetId !== undefined) {
        result.push([targetId, data]);
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
      const relsForEntity = entities?.get(entityId);
      if (relsForEntity) {
        for (const [relType, data] of relsForEntity) {
          result.push([relType, data]);
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
}
