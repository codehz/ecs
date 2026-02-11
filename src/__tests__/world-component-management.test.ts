import { beforeEach, describe, expect, it } from "bun:test";
import { component, createEntityId, relation, type ComponentId, type EntityId } from "../core/entity";
import { World } from "../core/world";

describe("World - Component Management", () => {
  type Position = { x: number; y: number };
  type Velocity = { x: number; y: number };

  let positionComponent: ComponentId<Position>;
  let velocityComponent: ComponentId<Velocity>;

  beforeEach(() => {
    positionComponent = component<Position>();
    velocityComponent = component<Velocity>();
  });

  it("should add components to entities", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    world.set(entity, positionComponent, position);
    world.sync(); // Execute deferred commands

    expect(world.has(entity, positionComponent)).toBe(true);
    expect(world.get(entity, positionComponent)).toEqual(position);
  });

  it("should update existing components", () => {
    const world = new World();
    const entity = world.new();
    const position1: Position = { x: 10, y: 20 };
    const position2: Position = { x: 30, y: 40 };

    world.set(entity, positionComponent, position1);
    world.sync();
    expect(world.get(entity, positionComponent)).toEqual(position1);

    world.set(entity, positionComponent, position2);
    world.sync();
    expect(world.get(entity, positionComponent)).toEqual(position2);
  });

  it("should remove components from entities", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    world.set(entity, positionComponent, position);
    world.sync();
    expect(world.has(entity, positionComponent)).toBe(true);

    world.remove(entity, positionComponent);
    world.sync();
    expect(world.has(entity, positionComponent)).toBe(false);
    expect(() => world.get(entity, positionComponent)).toThrow(
      /^Entity \d+ does not have component \d+\. Use has\(\) to check component existence before calling get\(\)\.$/,
    );
  });

  it("should throw error when removing invalid component type", () => {
    const world = new World();
    const entity = world.new();
    const invalidComponentType = 0 as EntityId<any>; // Invalid component ID

    expect(() => world.remove(entity, invalidComponentType)).toThrow("Invalid component type: 0");
  });

  it("should allow removing wildcard relation components", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };
    const targetEntity1 = world.new();
    const targetEntity2 = world.new();
    const relationId1 = relation(positionComponent, targetEntity1);
    const relationId2 = relation(positionComponent, targetEntity2);

    // Add multiple relation components with the same base component
    world.set(entity, relationId1, position);
    world.set(entity, relationId2, { x: 20, y: 30 });
    world.sync();
    expect(world.has(entity, relationId1)).toBe(true);
    expect(world.has(entity, relationId2)).toBe(true);

    // Remove using wildcard relation should remove all matching components
    const wildcardRelation = relation(positionComponent, "*");
    world.remove(entity, wildcardRelation);
    world.sync();
    expect(world.has(entity, relationId1)).toBe(false);
    expect(world.has(entity, relationId2)).toBe(false);
  });

  it("should get wildcard relation components", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };
    const targetEntity1 = world.new();
    const targetEntity2 = world.new();
    const relationId1 = relation(positionComponent, targetEntity1);
    const relationId2 = relation(positionComponent, targetEntity2);

    // Add multiple relation components with the same base component
    world.set(entity, relationId1, position);
    world.set(entity, relationId2, { x: 20, y: 30 });
    world.sync();

    // Get wildcard relations
    const wildcardRelation = relation(positionComponent, "*");
    const relations = world.get(entity, wildcardRelation);
    expect(relations).toEqual([
      [targetEntity2, { x: 20, y: 30 }],
      [targetEntity1, { x: 10, y: 20 }],
    ]);

    // Test with entity not having components
    const otherEntity = world.new();
    const result = world.get(otherEntity, wildcardRelation);
    expect(result).toEqual([]);
  });

  it("should handle exclusive relations", () => {
    const world = new World();
    const entity = world.new();
    const parent1 = world.new();
    const parent2 = world.new();

    // Create ChildOf component with exclusive option
    const ChildOf = component({ exclusive: true });

    const childOfParent1 = relation(ChildOf, parent1);
    const childOfParent2 = relation(ChildOf, parent2);

    // Add first relation
    world.set(entity, childOfParent1);
    world.sync();
    expect(world.has(entity, childOfParent1)).toBe(true);
    expect(world.has(entity, childOfParent2)).toBe(false);

    // Add second relation - should replace the first
    world.set(entity, childOfParent2);
    world.sync();
    expect(world.has(entity, childOfParent1)).toBe(false);
    expect(world.has(entity, childOfParent2)).toBe(true);
  });

  it("should cascade delete referencing entities when cascade enabled", () => {
    const world = new World();
    const parent = world.new();
    const child = world.new();
    // Create ChildOf component with cascadeDelete option
    const ChildOf = component({ cascadeDelete: true });

    const childOfParent = relation(ChildOf, parent);
    world.set(child, childOfParent);
    world.sync();

    world.delete(parent);
    world.sync();

    expect(world.exists(parent)).toBe(false);
    expect(world.exists(child)).toBe(false);
  });

  it("should not cascade delete referencing entities when cascade disabled", () => {
    const world = new World();
    const parent = world.new();
    const child = world.new();
    const ChildOf = component();

    const childOfParent = relation(ChildOf, parent);
    world.set(child, childOfParent);
    world.sync();

    world.delete(parent);
    world.sync();

    expect(world.exists(parent)).toBe(false);
    // child should still exist but without the relation
    expect(world.exists(child)).toBe(true);
    expect(world.has(child, childOfParent)).toBe(false);
  });

  it("should cascade delete transitively", () => {
    const world = new World();
    const a = world.new();
    const b = world.new();
    const c = world.new();
    // Create ChildOf component with cascadeDelete option
    const ChildOf = component({ cascadeDelete: true });

    world.set(b, relation(ChildOf, a));
    world.set(c, relation(ChildOf, b));
    world.sync();

    world.delete(a);
    world.sync();

    expect(world.exists(a)).toBe(false);
    expect(world.exists(b)).toBe(false);
    expect(world.exists(c)).toBe(false);
  });

  it("should handle cyclic cascade without infinite loop", () => {
    const world = new World();
    const a = world.new();
    const b = world.new();
    // Create ChildOf component with cascadeDelete option
    const ChildOf = component({ cascadeDelete: true });

    world.set(a, relation(ChildOf, b));
    world.set(b, relation(ChildOf, a));
    world.sync();

    world.delete(a);
    world.sync();

    expect(world.exists(a)).toBe(false);
    expect(world.exists(b)).toBe(false);
  });

  it("should prevent archetype fragmentation with dontFragment relations", () => {
    const world = new World();
    const entity1 = world.new();
    const entity2 = world.new();
    const target1 = world.new();
    const target2 = world.new();

    // Create Follows component with dontFragment option
    const Follows = component<{ strength: number }>({ dontFragment: true });

    const followsTarget1 = relation(Follows, target1);
    const followsTarget2 = relation(Follows, target2);

    // Add different relations to different entities
    world.set(entity1, followsTarget1, { strength: 1 });
    world.set(entity2, followsTarget2, { strength: 2 });
    world.sync();

    // Both entities should exist and have their relations
    expect(world.has(entity1, followsTarget1)).toBe(true);
    expect(world.has(entity2, followsTarget2)).toBe(true);

    // They should be in the same archetype despite having different relation targets
    // (this is the key behavior of dontFragment)
    const archetype1 = (world as any).entityToArchetype.get(entity1);
    const archetype2 = (world as any).entityToArchetype.get(entity2);
    expect(archetype1).toBe(archetype2);

    // Verify the wildcard marker is present
    const wildcardMarker = relation(Follows, "*");
    expect(archetype1.componentTypes).toContain(wildcardMarker);
  });

  it("should support cascadeDelete and dontFragment simultaneously", () => {
    const world = new World();
    const parent = world.new();
    const child1 = world.new();
    const child2 = world.new();

    // Create ChildOf component with both cascadeDelete and dontFragment options
    const ChildOf = component<{ priority: number }>({ cascadeDelete: true, dontFragment: true });

    const childOfParent1 = relation(ChildOf, parent);
    const childOfParent2 = relation(ChildOf, parent);

    // Add relations to children
    world.set(child1, childOfParent1, { priority: 1 });
    world.set(child2, childOfParent2, { priority: 2 });
    world.sync();

    // Verify relations exist
    expect(world.has(child1, childOfParent1)).toBe(true);
    expect(world.has(child2, childOfParent2)).toBe(true);

    // Both children should be in the same archetype (dontFragment behavior)
    const archetype1 = (world as any).entityToArchetype.get(child1);
    const archetype2 = (world as any).entityToArchetype.get(child2);
    expect(archetype1).toBe(archetype2);

    // Delete parent - should cascade delete both children (cascadeDelete behavior)
    world.delete(parent);
    world.sync();

    expect(world.exists(parent)).toBe(false);
    expect(world.exists(child1)).toBe(false);
    expect(world.exists(child2)).toBe(false);
  });

  it("should handle multiple components", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };
    const velocity: Velocity = { x: 1, y: 2 };

    world.set(entity, positionComponent, position);
    world.set(entity, velocityComponent, velocity);
    world.sync();

    expect(world.has(entity, positionComponent)).toBe(true);
    expect(world.has(entity, velocityComponent)).toBe(true);
    expect(world.get(entity, positionComponent)).toEqual(position);
    expect(world.get(entity, velocityComponent)).toEqual(velocity);
  });

  it("should throw error when adding component to non-existent entity", () => {
    const world = new World();
    const fakeEntity = createEntityId(9999);
    const position: Position = { x: 10, y: 20 };

    expect(() => world.set(fakeEntity, positionComponent, position)).toThrow("Entity 9999 does not exist");
  });

  it("should throw error when adding invalid component type", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };
    const invalidComponentType = 0 as EntityId<any>; // Invalid component ID

    expect(() => world.set(entity, invalidComponentType, position)).toThrow("Invalid component type: 0");
  });

  it("should throw error when adding wildcard relation component", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };
    const wildcardRelation = relation(positionComponent, "*");

    expect(() => world.set(entity, wildcardRelation, position)).toThrow(
      "Cannot directly add wildcard relation components",
    );
  });

  it("should throw error when getting component from non-existent entity", () => {
    const world = new World();
    const fakeEntity = createEntityId(9999);

    expect(() => world.get(fakeEntity, positionComponent)).toThrow("Entity 9999 does not exist");
  });

  it("should allow setting undefined as component data", () => {
    const world = new World();
    const entity = world.new();

    const optionalPositionComponent = component<Position | undefined>();

    // Add component with undefined data
    world.set(entity, optionalPositionComponent, undefined);
    world.sync();

    expect(world.has(entity, optionalPositionComponent)).toBe(true);
    expect(world.get(entity, optionalPositionComponent)).toBeUndefined();

    // Update to a defined value
    const position: Position = { x: 10, y: 20 };
    world.set(entity, optionalPositionComponent, position);
    world.sync();
    expect(world.get(entity, optionalPositionComponent)).toEqual(position);

    // Update back to undefined
    world.set(entity, optionalPositionComponent, undefined);
    world.sync();
    expect(world.get(entity, optionalPositionComponent)).toBeUndefined();
  });
});
