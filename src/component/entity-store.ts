import { hasWildcardRelation } from "../archetype/helpers";
import type { Command } from "../commands/buffer";
import {
  getComponentIdFromRelationId,
  getComponentMerge,
  getDetailedIdType,
  isWildcardRelationId,
  type ComponentId,
  type EntityId,
  type WildcardRelationId,
} from "../entity";

/**
 * Manages component entity (singleton) storage.
 *
 * Component entities use a flat Map-based storage rather than the Archetype-based
 * storage used for regular entities. Their IDs are in the component ID range
 * (or are relation IDs), distinguishing them from regular entity IDs.
 */
export class ComponentEntityStore {
  private readonly componentEntityComponents: Map<EntityId, Map<EntityId<any>, any>> = new Map();
  private readonly relationEntityIdsByTarget: Map<EntityId, Set<EntityId>> = new Map();

  /**
   * Check if an entity ID is a component entity type.
   * Returns true for component IDs, component-relation IDs, and entity-relation IDs —
   * i.e. anything that is NOT a plain entity or an invalid ID.
   */
  exists(entityId: EntityId): boolean {
    const detailed = getDetailedIdType(entityId);
    return detailed.type !== "entity" && detailed.type !== "invalid";
  }

  /**
   * Check if a component entity has a specific component.
   */
  has(entityId: EntityId, componentType: EntityId<any>): boolean {
    return this.componentEntityComponents.get(entityId)?.has(componentType) ?? false;
  }

  /**
   * Check if a singleton component has data — the has(componentId) overload.
   * In singleton usage the entity ID and the component type are the same value.
   */
  hasSingleton(componentId: EntityId<any>): boolean {
    return this.componentEntityComponents.get(componentId)?.has(componentId) ?? false;
  }

  /**
   * Check if a component entity has any wildcard relations matching a component ID.
   */
  hasWildcard(entityId: EntityId, componentId: ComponentId<any>): boolean {
    const data = this.componentEntityComponents.get(entityId);
    if (!data) return false;
    return hasWildcardRelation(data, componentId);
  }

  /**
   * Get a component value from a component entity.
   * Throws if the component does not exist.
   */
  get<T>(entityId: EntityId, componentType: EntityId<T>): T {
    const data = this.componentEntityComponents.get(entityId);
    if (!data || !data.has(componentType)) {
      throw new Error(
        `Entity ${entityId} does not have component ${componentType}. Use has() to check component existence before calling get().`,
      );
    }
    return data.get(componentType) as T;
  }

  /**
   * Get an optional component value from a component entity.
   * Returns undefined if the component does not exist.
   */
  getOptional<T>(entityId: EntityId, componentType: EntityId<T>): { value: T } | undefined {
    const data = this.componentEntityComponents.get(entityId);
    if (!data || !data.has(componentType)) return undefined;
    return { value: data.get(componentType) as T };
  }

  /**
   * Get all wildcard relations of a given type from a component entity.
   */
  getWildcard<T>(entityId: EntityId, wildcardComponentType: WildcardRelationId<T>): [EntityId<unknown>, T][] {
    const componentId = getComponentIdFromRelationId(wildcardComponentType);
    const data = this.componentEntityComponents.get(entityId);
    if (componentId === undefined || !data) return [];

    const relations: [EntityId<unknown>, T][] = [];
    for (const [key, value] of data.entries()) {
      if (getComponentIdFromRelationId(key) !== componentId) continue;
      const detailed = getDetailedIdType(key);
      if (detailed.type === "entity-relation" || detailed.type === "component-relation") {
        relations.push([detailed.targetId, value as T]);
      }
    }
    return relations;
  }

  /**
   * Clear all data for a component entity.
   */
  clear(entityId: EntityId): void {
    if (this.componentEntityComponents.delete(entityId)) {
      this.unregisterRelationEntityId(entityId);
    }
  }

  /**
   * Cleanup all component entities that reference a given target entity.
   * Called when a target entity is destroyed.
   */
  cleanupReferencesTo(targetId: EntityId): void {
    const relationEntities = this.relationEntityIdsByTarget.get(targetId);
    if (!relationEntities) return;
    for (const relationEntityId of relationEntities) {
      this.componentEntityComponents.delete(relationEntityId);
    }
    this.relationEntityIdsByTarget.delete(targetId);
  }

  /**
   * Execute a batch of commands for a component entity.
   */
  executeCommands(entityId: EntityId, commands: Command[]): void {
    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.clear(entityId);
      return;
    }

    const pendingSetValues = new Map<EntityId<any>, any>();

    for (const command of commands) {
      if (command.type === "set" && command.componentType) {
        const merge = getComponentMerge(command.componentType);
        let nextValue = command.component;
        if (merge !== undefined && pendingSetValues.has(command.componentType)) {
          const prevValue = pendingSetValues.get(command.componentType);
          nextValue = merge(prevValue, command.component);
        }
        pendingSetValues.set(command.componentType, nextValue);

        let data = this.componentEntityComponents.get(entityId);
        if (!data) {
          data = new Map();
          this.componentEntityComponents.set(entityId, data);
          this.registerRelationEntityId(entityId);
        }
        data.set(command.componentType, nextValue);
      } else if (command.type === "delete" && command.componentType) {
        const data = this.componentEntityComponents.get(entityId);

        if (isWildcardRelationId(command.componentType)) {
          const componentId = getComponentIdFromRelationId(command.componentType);
          if (componentId !== undefined) {
            if (data) {
              for (const key of Array.from(data.keys())) {
                if (getComponentIdFromRelationId(key) === componentId) {
                  data.delete(key);
                }
              }
            }
            for (const key of Array.from(pendingSetValues.keys())) {
              if (getComponentIdFromRelationId(key) === componentId) {
                pendingSetValues.delete(key);
              }
            }
          }
        } else {
          data?.delete(command.componentType);
          pendingSetValues.delete(command.componentType);
        }

        if (data?.size === 0) {
          this.clear(entityId);
        }
      }
    }
  }

  /**
   * Initialize a component entity from a deserialization snapshot.
   */
  initFromSnapshot(entityId: EntityId, componentMap: Map<EntityId<any>, any>): void {
    this.componentEntityComponents.set(entityId, componentMap);
    this.registerRelationEntityId(entityId);
  }

  /**
   * Iterate over all component entity entries.
   * Used for serialization.
   */
  entries(): IterableIterator<[EntityId, Map<EntityId<any>, any>]> {
    return this.componentEntityComponents.entries();
  }

  private registerRelationEntityId(entityId: EntityId): void {
    const detailed = getDetailedIdType(entityId);
    if (detailed.type !== "entity-relation") return;
    const targetId = detailed.targetId;
    if (targetId === undefined) return;
    const existing = this.relationEntityIdsByTarget.get(targetId);
    if (existing) {
      existing.add(entityId);
      return;
    }
    this.relationEntityIdsByTarget.set(targetId, new Set([entityId]));
  }

  private unregisterRelationEntityId(entityId: EntityId): void {
    const detailed = getDetailedIdType(entityId);
    if (detailed.type !== "entity-relation") return;
    const targetId = detailed.targetId;
    if (targetId === undefined) return;
    const existing = this.relationEntityIdsByTarget.get(targetId);
    if (!existing) return;
    existing.delete(entityId);
    if (existing.size === 0) {
      this.relationEntityIdsByTarget.delete(targetId);
    }
  }
}
