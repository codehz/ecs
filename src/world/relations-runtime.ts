import type { Archetype } from "../archetype/archetype";
import type { ComponentEntityStore } from "../component/entity-store";
import type { ComponentId, EntityId, WildcardRelationId , EntityIdManager} from "../entity";
import { getComponentIdFromRelationId, isCascadeDeleteRelation, relation } from "../entity";
import { triggerRemoveHooksForEntityDeletion } from "./hooks";
import { assertEntityExists } from "./operations";
import { getEntityReferences, type EntityReferencesMap } from "./references";

/**
 * Narrow dependencies for RelationsRuntime (destroy + reverse refs + hierarchy).
 * World (composition root) supplies these; Relations owns entityReferences.
 */
export interface RelationsRuntimeContext {
  entityToArchetype: Map<EntityId, Archetype>;
  entityIdManager: EntityIdManager;
  componentEntities: ComponentEntityStore;
  removeComponentImmediate: (entityId: EntityId, componentType: EntityId<any>, targetEntityId: EntityId) => void;
  cleanupArchetypesReferencingEntity: (entityId: EntityId) => void;
  exists: (entityId: EntityId) => boolean;
  has: (entityId: EntityId, componentType: EntityId<any>) => boolean;
  get: <T>(entityId: EntityId, componentType: EntityId<T> | WildcardRelationId<T>) => T | [EntityId<unknown>, any][];
}

/**
 * RelationsRuntime owns the reverse reference index, cascade destroy, and
 * hierarchy / relation companion helpers.
 *
 * Public World methods for hierarchy remain as thin facades over this class.
 */
export class RelationsRuntime {
  readonly entityReferences: EntityReferencesMap = new Map();

  constructor(private readonly ctx: RelationsRuntimeContext) {}

  get size(): number {
    return this.entityReferences.size;
  }

  /** Fast path: destroy an entity that is not referenced by any other entity, skipping BFS */
  private destroySingleEntity(entityId: EntityId): void {
    const archetype = this.ctx.entityToArchetype.get(entityId);
    if (!archetype) return;

    // Handle entity references (this entity is referenced by other entities)
    for (const [sourceEntityId, componentType] of getEntityReferences(this.entityReferences, entityId)) {
      if (this.ctx.entityToArchetype.has(sourceEntityId)) {
        this.ctx.removeComponentImmediate(sourceEntityId, componentType, entityId);
      }
    }

    this.entityReferences.delete(entityId);
    const removedComponents = archetype.removeEntity(entityId)!;
    this.ctx.entityToArchetype.delete(entityId);

    triggerRemoveHooksForEntityDeletion(entityId, removedComponents, archetype);

    this.ctx.cleanupArchetypesReferencingEntity(entityId);
    this.ctx.entityIdManager.deallocate(entityId);
    this.ctx.componentEntities.cleanupReferencesTo(entityId);
  }

  /**
   * Immediate destroy with cascade support (BFS over cascadeDelete relations).
   * Invoked from CommandExecutor when a destroy command is flushed.
   */
  destroyEntityImmediate(entityId: EntityId): void {
    // Fast path: no other entity references this one, delete directly
    if (!this.entityReferences.has(entityId)) {
      this.destroySingleEntity(entityId);
      return;
    }

    const queue: EntityId[] = [entityId];
    const visited = new Set<EntityId>();
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const cur = queue[queueIndex++]!;
      if (visited.has(cur)) continue;
      visited.add(cur);

      const archetype = this.ctx.entityToArchetype.get(cur);
      if (!archetype) continue;

      // Process entity references before removal
      for (const [sourceEntityId, componentType] of getEntityReferences(this.entityReferences, cur)) {
        if (!this.ctx.entityToArchetype.has(sourceEntityId)) continue;

        if (isCascadeDeleteRelation(componentType)) {
          if (!visited.has(sourceEntityId)) {
            queue.push(sourceEntityId);
          }
        } else {
          this.ctx.removeComponentImmediate(sourceEntityId, componentType, cur);
        }
      }

      // Remove entity from archetype - this also cleans up sparse relations
      // and returns all removed component data
      this.entityReferences.delete(cur);
      const removedComponents = archetype.removeEntity(cur)!;
      this.ctx.entityToArchetype.delete(cur);

      // Trigger lifecycle hooks for removed components (fast path for entity deletion)
      triggerRemoveHooksForEntityDeletion(cur, removedComponents, archetype);

      this.ctx.cleanupArchetypesReferencingEntity(cur);
      this.ctx.entityIdManager.deallocate(cur);
      this.ctx.componentEntities.cleanupReferencesTo(cur);
    }
  }

  getRelationTargets<T = void>(
    entityId: EntityId,
    relationComp: ComponentId<T>,
  ): [target: EntityId<unknown>, data: T | undefined][] {
    assertEntityExists(entityId, "Entity", this.ctx.exists);

    const wildcard = relation(relationComp, "*") as WildcardRelationId<T>;

    if (this.ctx.componentEntities.exists(entityId)) {
      return this.ctx.componentEntities.getWildcard(entityId, wildcard);
    }

    const data = this.ctx.get(entityId, wildcard);
    return data as [EntityId<unknown>, T | undefined][];
  }

  getRelationSources(targetId: EntityId, relationComp: ComponentId<any>): EntityId[] {
    const refs = getEntityReferences(this.entityReferences, targetId);
    const result: EntityId[] = [];

    for (const [source, relType] of refs) {
      if (!this.ctx.entityToArchetype.has(source) && !this.ctx.componentEntities.exists(source)) continue;

      const decodedComp = getComponentIdFromRelationId(relType);
      if (decodedComp === relationComp) {
        result.push(source);
      }
    }
    return result;
  }

  hasRelation(entityId: EntityId, relationComp: ComponentId<any>, targetId?: EntityId): boolean {
    assertEntityExists(entityId, "Entity", this.ctx.exists);

    if (targetId !== undefined) {
      const specific = relation(relationComp, targetId);
      return this.ctx.has(entityId, specific);
    }

    const targets = this.getRelationTargets(entityId, relationComp);
    return targets.length > 0;
  }

  countRelations(entityId: EntityId, relationComp: ComponentId<any>): number {
    assertEntityExists(entityId, "Entity", this.ctx.exists);
    return this.getRelationTargets(entityId, relationComp).length;
  }

  getSingleRelationTarget<T = void>(entityId: EntityId, relationComp: ComponentId<T>): EntityId | undefined {
    const targets = this.getRelationTargets(entityId, relationComp);
    return targets.length > 0 ? (targets[0]![0] as EntityId) : undefined;
  }

  getChildren(parent: EntityId, childOf: ComponentId<any>): EntityId[] {
    return this.getRelationSources(parent, childOf);
  }

  getParent(child: EntityId, childOf: ComponentId<any>): EntityId | undefined {
    return this.getSingleRelationTarget(child, childOf);
  }

  getAncestors(entity: EntityId, childOf: ComponentId<any>): EntityId[] {
    const ancestors: EntityId[] = [];
    let cur = this.getParent(entity, childOf);
    while (cur !== undefined) {
      ancestors.push(cur);
      cur = this.getParent(cur, childOf);
    }
    return ancestors;
  }

  *iterateDescendants(
    root: EntityId,
    childOf: ComponentId<any>,
    opts: { includeSelf?: boolean; maxDepth?: number } = {},
  ): IterableIterator<{ entity: EntityId; depth: number; parent: EntityId | null }> {
    const { includeSelf = false, maxDepth } = opts;
    const stack: Array<{ entity: EntityId; depth: number; parent: EntityId | null }> = [];

    if (includeSelf) {
      stack.push({ entity: root, depth: 0, parent: null });
    } else {
      for (const child of this.getChildren(root, childOf)) {
        stack.push({ entity: child, depth: 1, parent: root });
      }
    }

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (maxDepth !== undefined && current.depth > maxDepth) continue;

      yield current;

      const kids = this.getChildren(current.entity, childOf);
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i]!;
        stack.push({ entity: k, depth: current.depth + 1, parent: current.entity });
      }
    }
  }

  traverseDescendants(
    root: EntityId,
    childOf: ComponentId<any>,
    visitor: (entity: EntityId, depth: number, parent: EntityId | null) => void | boolean,
    opts: { includeSelf?: boolean; maxDepth?: number } = {},
  ): void {
    for (const { entity, depth, parent } of this.iterateDescendants(root, childOf, opts)) {
      const res = visitor(entity, depth, parent);
      if (res === false) return;
    }
  }
}
