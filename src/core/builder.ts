import type { ComponentId, EntityId } from "./entity";
import { relation } from "./entity";
import type { World } from "./world";

// =============================================================================
// EntityBuilder - Fluent Entity Creation (moved from testing utilities)
// =============================================================================

/**
 * A component definition for entity building, supporting both regular components and relations
 */
export type ComponentDef<T = unknown> =
  | { type: "component"; id: EntityId<T>; value: T }
  | { type: "relation"; componentId: ComponentId<T>; targetId: EntityId<any>; value: T };

export class EntityBuilder {
  private world: World;
  private components: ComponentDef[] = [];

  constructor(world: World) {
    this.world = world;
  }

  with<T>(componentId: EntityId<T>, value: T): this {
    this.components.push({ type: "component", id: componentId, value });
    return this;
  }

  withTag(componentId: EntityId<void>): this {
    this.components.push({ type: "component", id: componentId, value: undefined as void });
    return this;
  }

  withRelation<T>(componentId: ComponentId<T>, targetEntity: EntityId<any>, value: T): this {
    this.components.push({ type: "relation", componentId, targetId: targetEntity, value });
    return this;
  }

  withRelationTag(componentId: ComponentId<void>, targetEntity: EntityId<any>): this {
    this.components.push({ type: "relation", componentId, targetId: targetEntity, value: undefined as void });
    return this;
  }

  /**
   * Create an entity and enqueue components to be applied. This method
   * does NOT call `world.sync()` automatically; callers must invoke
   * `world.sync()` to apply deferred commands.
   * (Previously auto-synced; now a breaking change — buildDeferred() removed.)
   */
  build(): EntityId {
    const entity = this.world.new();

    for (const def of this.components) {
      if (def.type === "component") {
        this.world.set(entity, def.id, def.value as any);
      } else {
        const relationId = relation(def.componentId, def.targetId);
        this.world.set(entity, relationId, def.value as any);
      }
    }

    return entity;
  }
}
