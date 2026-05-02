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

/**
 * Fluent API for constructing entities with multiple components.
 * Create instances via {@link World.spawn}.
 *
 * @example
 * const entity = world.spawn()
 *   .with(Position, { x: 0, y: 0 })
 *   .withRelation(Parent, parentEntity)
 *   .build();
 * world.sync();
 */
export class EntityBuilder {
  private world: World;
  private components: ComponentDef[] = [];

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Add a regular component to the entity under construction.
   *
   * @template T - The component data type
   * @param componentId - The component type to add
   * @param args - Component data (omit for void components)
   * @returns This builder for chaining
   *
   * @example
   * builder.with(Position, { x: 10, y: 20 });
   * builder.with(Marker); // void component
   */
  with<T>(componentId: EntityId<T>, ...args: T extends void ? [] | [void] : [T]): this {
    const value = (args.length > 0 ? args[0] : undefined) as T;
    this.components.push({ type: "component", id: componentId, value });
    return this;
  }

  /**
   * Add a relation component to the entity under construction.
   *
   * @template T - The relation data type
   * @param componentId - The base component type for the relation
   * @param targetEntity - The target entity or component for the relation
   * @param args - Relation data (omit for void relations)
   * @returns This builder for chaining
   *
   * @example
   * builder.withRelation(Parent, parentEntity);
   * builder.withRelation(ChildOf, childEntity, { order: 1 });
   */
  withRelation<T>(
    componentId: ComponentId<T>,
    targetEntity: EntityId<any>,
    ...args: T extends void ? [] | [void] : [T]
  ): this {
    const value = (args.length > 0 ? args[0] : undefined) as T;
    this.components.push({ type: "relation", componentId, targetId: targetEntity, value });
    return this;
  }

  /**
   * Create the entity and enqueue all configured components.
   * The entity and components are only materialised after {@link World.sync} is called.
   *
   * @returns The newly created entity ID
   *
   * @example
   * const entity = world.spawn()
   *   .with(Position, { x: 0, y: 0 })
   *   .build();
   * world.sync(); // Apply changes
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
