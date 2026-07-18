import type { Archetype } from "../archetype/archetype";
import type { SparseStore } from "../archetype/store";
import type { ComponentEntityStore } from "../component/entity-store";
import type { ComponentId, EntityId, WildcardRelationId } from "../entity";
import { RELATION_SHIFT, getComponentIdFromRelationId, isSparseRelation, isWildcardRelationId } from "../entity";

/**
 * Core entity/component read path: dual storage dispatch for
 * component-entities (singletons) vs regular archetype entities + sparse.
 *
 * World / CommandExecutor / Hooks share one instance so has/get semantics
 * stay single-sourced.
 */
export class EntityAccess {
  constructor(
    private readonly componentEntities: ComponentEntityStore,
    private readonly entityToArchetype: Map<EntityId, Archetype>,
    private readonly sparseStore: SparseStore,
  ) {}

  exists(entityId: EntityId): boolean {
    if (this.componentEntities.exists(entityId)) return true;
    return this.entityToArchetype.has(entityId);
  }

  has<T>(entityId: EntityId | ComponentId, componentType?: EntityId<T>): boolean {
    // Handle singleton component overload: has(componentId)
    if (componentType === undefined) {
      const componentId = entityId as ComponentId<T>;
      return this.componentEntities.hasSingleton(componentId);
    }

    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId === undefined) return false;
        return this.componentEntities.hasWildcard(entityId, componentId);
      }
      return this.componentEntities.has(entityId, componentType);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) return false;

    if (archetype.componentTypeSet.has(componentType)) return true;

    if (isSparseRelation(componentType)) {
      return this.sparseStore.hasValue(entityId, componentType);
    }

    return false;
  }

  get<T>(
    entityId: EntityId,
    componentType: EntityId<T> | WildcardRelationId<T> = entityId as EntityId<T>,
  ): T | [EntityId<unknown>, any][] {
    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType as EntityId<any>)) {
        return this.componentEntities.getWildcard(entityId, componentType as WildcardRelationId<T>);
      }
      return this.componentEntities.get(entityId, componentType as EntityId<T>);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (componentType >= 0 || componentType % RELATION_SHIFT !== 0) {
      const inArchetype = archetype.componentTypeSet.has(componentType);
      const hasComponent =
        inArchetype || (isSparseRelation(componentType) && this.sparseStore.hasValue(entityId, componentType));

      if (!hasComponent) {
        throw new Error(
          `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
        );
      }
    }

    return archetype.get(entityId, componentType) as T | [EntityId<unknown>, any][];
  }

  getOptional<T>(
    entityId: EntityId,
    componentType: EntityId<T> | WildcardRelationId<T> = entityId as EntityId<T>,
  ): { value: T } | { value: [EntityId<unknown>, T][] } | undefined {
    if (this.componentEntities.exists(entityId)) {
      if (isWildcardRelationId(componentType)) {
        const relations = this.componentEntities.getWildcard(entityId, componentType);
        if (relations.length === 0) return undefined;
        return { value: relations };
      }
      return this.componentEntities.getOptional(entityId, componentType);
    }

    const archetype = this.entityToArchetype.get(entityId);
    if (!archetype) {
      throw new Error(`Entity ${entityId} does not exist`);
    }

    if (isWildcardRelationId(componentType)) {
      const wildcardData = archetype.get(entityId, componentType) as [EntityId<unknown>, T][];
      if (Array.isArray(wildcardData) && wildcardData.length > 0) {
        return { value: wildcardData };
      }
      return undefined;
    }

    return archetype.getOptional(entityId, componentType);
  }
}
