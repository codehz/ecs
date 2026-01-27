import { describe, expect, it } from "bun:test";
import { component, relation } from "../core/entity";
import { World } from "../core/world";

describe("World - Query", () => {
  type Position = { x: number; y: number };
  type Velocity = { x: number; y: number };

  const markComponent = component();
  const positionComponent = component<Position>();
  const velocityComponent = component<Velocity>();

  it("should query entities with specific components", () => {
    const world = new World();
    const entity1 = world.new();
    const entity2 = world.new();
    const entity3 = world.new();

    world.set(entity1, positionComponent, { x: 1, y: 2 });
    world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

    world.set(entity2, positionComponent, { x: 3, y: 4 });

    // entity3 has no components

    world.sync(); // Execute deferred commands

    const positionEntities = world.query([positionComponent]);
    expect(positionEntities).toContain(entity1);
    expect(positionEntities).toContain(entity2);
    expect(positionEntities).not.toContain(entity3);

    const velocityEntities = world.query([velocityComponent]);
    expect(velocityEntities).toContain(entity1);
    expect(velocityEntities).not.toContain(entity2);
    expect(velocityEntities).not.toContain(entity3);

    const bothEntities = world.query([positionComponent, velocityComponent]);
    expect(bothEntities).toContain(entity1);
    expect(bothEntities).not.toContain(entity2);
    expect(bothEntities).not.toContain(entity3);
  });

  it("should return empty array for queries with no matches", () => {
    const world = new World();
    const entity = world.new();
    world.set(entity, positionComponent, { x: 1, y: 2 });

    const result = world.query([velocityComponent]);
    expect(result).toEqual([]);
  });

  it("should query entities with wildcard relations", () => {
    const world = new World();
    const entity1 = world.new();
    const entity2 = world.new();
    const entity3 = world.new();

    // Create a wildcard relation for position component
    const wildcardPositionRelation = relation(markComponent, "*");

    world.set(entity1, relation(markComponent, positionComponent), { x: 1, y: 2 });
    world.set(entity1, relation(markComponent, velocityComponent), { x: 0.1, y: 0.2 });

    world.set(entity2, relation(markComponent, positionComponent), { x: 3, y: 4 });

    world.set(entity3, positionComponent, { x: 5, y: 6 });

    // entity3 has no position component

    world.sync(); // Execute deferred commands

    // Query with wildcard relation should find all entities with position component
    const wildcardEntities = world.query([wildcardPositionRelation]);
    expect(wildcardEntities).toContain(entity1);
    expect(wildcardEntities).toContain(entity2);
    expect(wildcardEntities).not.toContain(entity3);
  });

  it("should query entities with mixed component and wildcard relation queries", () => {
    const world = new World();
    const entity1 = world.new();
    const entity2 = world.new();
    const entity3 = world.new();

    // Create a wildcard relation for position component
    const wildcardPositionRelation = relation(markComponent, "*");

    world.set(entity1, relation(markComponent, positionComponent), { x: 1, y: 2 });
    world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

    world.set(entity2, relation(markComponent, positionComponent), { x: 3, y: 4 });
    // entity2 doesn't have velocity

    world.set(entity3, velocityComponent, { x: 0.5, y: 0.6 });
    // entity3 doesn't have position

    world.sync(); // Execute deferred commands

    // Query with both velocity component and wildcard position relation
    // Should only match entity1 (has both position and velocity)
    const mixedEntities = world.query([velocityComponent, wildcardPositionRelation]);
    expect(mixedEntities).toContain(entity1);
    expect(mixedEntities).not.toContain(entity2);
    expect(mixedEntities).not.toContain(entity3);
  });

  it("should clean up relation components when target entity is destroyed", () => {
    const world = new World();

    // Create component IDs
    const positionComponent = component<{ x: number; y: number }>();
    const followsComponent = component<void>();

    // Create entities
    const entity1 = world.new(); // This will be followed
    const entity2 = world.new(); // This will follow entity1
    const entity3 = world.new(); // This will also follow entity1

    // Add position to entity1
    world.set(entity1, positionComponent, { x: 10, y: 20 });
    world.sync();

    // Create relation components (entity2 and entity3 follow entity1)
    const followsEntity1 = relation(followsComponent, entity1);
    world.set(entity2, followsEntity1);
    world.set(entity3, followsEntity1);
    world.sync();
    // Add twice to test idempotency
    world.set(entity2, followsEntity1);
    world.set(entity3, followsEntity1);
    world.sync();

    // Verify relations exist
    expect(world.has(entity2, followsEntity1)).toBe(true);
    expect(world.has(entity3, followsEntity1)).toBe(true);

    // Query entities that follow entity1
    const followers = world.query([followsEntity1]);
    expect(followers).toContain(entity2);
    expect(followers).toContain(entity3);

    // Destroy entity1
    world.delete(entity1);
    world.sync();

    // Verify entity1 is destroyed
    expect(world.exists(entity1)).toBe(false);

    // Verify relation components are cleaned up
    expect(world.has(entity2, followsEntity1)).toBe(false);
    expect(world.has(entity3, followsEntity1)).toBe(false);

    // Query should now return empty
    const followersAfterDestroy = world.query([followsEntity1]);
    expect(followersAfterDestroy).toHaveLength(0);

    // entity2 and entity3 should still exist but without the relation components
    expect(world.exists(entity2)).toBe(true);
    expect(world.exists(entity3)).toBe(true);
  });

  it("should clean up components when entity is used directly as component type and destroyed", () => {
    const world = new World();

    // Create entities
    const entity1 = world.new(); // This will be used as component type
    const entity2 = world.new(); // This will have entity1 as component

    // Add entity1 directly as a component type to entity2
    world.set(entity2, entity1);
    world.sync();

    // Verify the component exists
    expect(world.has(entity2, entity1)).toBe(true);

    // Query entities that have entity1 as component
    const entitiesWithComponent = world.query([entity1]);
    expect(entitiesWithComponent).toContain(entity2);

    // Destroy entity1
    world.delete(entity1);
    world.sync();

    // Verify entity1 is destroyed
    expect(world.exists(entity1)).toBe(false);

    // Verify the component is cleaned up
    expect(world.has(entity2, entity1)).toBe(false);

    // Query should now return empty
    const entitiesWithComponentAfterDestroy = world.query([entity1]);
    expect(entitiesWithComponentAfterDestroy).toHaveLength(0);

    // entity2 should still exist
    expect(world.exists(entity2)).toBe(true);
  });
});
