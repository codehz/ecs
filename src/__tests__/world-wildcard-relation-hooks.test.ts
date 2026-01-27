import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../core/entity";
import { World } from "../core/world";

describe("World - Wildcard Relation Hooks", () => {
  it("should trigger wildcard relation hooks for matching relation components", () => {
    const world = new World();
    const positionComponent = component<{ x: number; y: number }>();
    const entity1 = world.new();
    const entity2 = world.new();

    // Create a relation component (positionComponent -> entity2)
    const relationId = relation(positionComponent, entity2);

    // Create a wildcard relation ID for positionComponent
    const wildcardRelationId = relation(positionComponent, "*");

    let addedCalled = false;
    let removedCalled = false;
    let addedComponentType: EntityId<{ x: number; y: number }> | undefined;
    let removedComponentType: EntityId<{ x: number; y: number }> | undefined;

    // Register a wildcard relation hook for positionComponent
    world.hook(wildcardRelationId, {
      on_set: (entityId, componentType, _component) => {
        addedCalled = true;
        addedComponentType = componentType;
      },
      on_remove: (entityId, componentType) => {
        removedCalled = true;
        removedComponentType = componentType;
      },
    });

    // Add the relation component
    world.set(entity1, relationId, { x: 10, y: 20 });
    world.sync();

    expect(addedCalled).toBe(true);
    expect(addedComponentType).toBe(relationId);

    // Remove the relation component
    world.remove(entity1, relationId);
    world.sync();

    expect(removedCalled).toBe(true);
    expect(removedComponentType).toBe(relationId);
  });

  it("should not trigger wildcard relation hooks for non-matching components", () => {
    const world = new World();
    const positionComponent = component<{ x: number; y: number }>();
    const velocityComponent = component<{ vx: number; vy: number }>();
    const entity1 = world.new();

    // Create a wildcard relation ID for positionComponent
    const wildcardRelationId = relation(positionComponent, "*");

    let hookCalled = false;

    // Register a wildcard relation hook for positionComponent
    world.hook(wildcardRelationId, {
      on_set: () => {
        hookCalled = true;
      },
    });

    // Add a velocity component (not a position relation)
    world.set(entity1, velocityComponent, { vx: 1, vy: 2 });
    world.sync();

    expect(hookCalled).toBe(false);
  });
});
