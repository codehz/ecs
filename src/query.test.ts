import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "./entity";
import { World } from "./world";

describe("Query", () => {
  describe("Query Creation and Basic Functionality", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };
    type Health = { value: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();
    const healthComponent = component<Health>();

    it("should create a query and return matching entities", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity3 has no components

      world.sync(); // Execute deferred commands

      const entities = query.getEntities();
      expect(entities).toContain(entity1);
      expect(entities).toContain(entity2);
      expect(entities).not.toContain(entity3);
    });

    it("should update cache when new archetypes are created", () => {
      const world = new World();
      const query = world.createQuery([positionComponent, velocityComponent]);

      const entity1 = world.new();
      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.sync();

      // Initially should have entity1
      expect(query.getEntities()).toEqual([entity1]);

      // Create entity2 with same components (should reuse archetype)
      const entity2 = world.new();
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      world.set(entity2, velocityComponent, { x: 0.2, y: 0.3 });

      world.sync();

      // Should still work (archetype reused, no new archetype created)
      expect(query.getEntities()).toContain(entity1);
      expect(query.getEntities()).toContain(entity2);

      // Create entity3 with only position (creates new archetype)
      const entity3 = world.new();
      world.set(entity3, positionComponent, { x: 5, y: 6 });

      // Query should still only return entities with both components
      const entities = query.getEntities();
      expect(entities).toContain(entity1);
      expect(entities).toContain(entity2);
      expect(entities).not.toContain(entity3);
    });

    it("should handle empty results", () => {
      const world = new World();
      const query = world.createQuery([velocityComponent]);

      const entity = world.new();
      world.set(entity, positionComponent, { x: 1, y: 2 });

      const entities = query.getEntities();
      expect(entities).toEqual([]);
    });

    it("should dispose properly", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity = world.new();
      world.set(entity, positionComponent, { x: 1, y: 2 });

      world.sync();

      expect(query.disposed).toBe(false);
      expect(query.getEntities()).toEqual([entity]);

      query.dispose();
      expect(query.disposed).toBe(true);

      // Should throw after dispose
      expect(() => query.getEntities()).toThrow("Query has been disposed");
      // iterate should also throw
      expect(() => {
        // use spread to attempt to consume iterator
        [...query.iterate([positionComponent])];
      }).toThrow("Query has been disposed");
    });

    it("should handle multiple queries", () => {
      const world = new World();
      const positionQuery = world.createQuery([positionComponent]);
      const velocityQuery = world.createQuery([velocityComponent]);
      const bothQuery = world.createQuery([positionComponent, velocityComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });

      world.sync();

      const positionEntities = positionQuery.getEntities();
      expect(positionEntities).toContain(entity1);
      expect(positionEntities).toContain(entity2);
      expect(positionEntities.length).toBe(2);
      expect(velocityQuery.getEntities()).toEqual([entity1]);
      expect(bothQuery.getEntities()).toEqual([entity1]);
    });

    it("should handle query disposal without affecting other queries", () => {
      const world = new World();
      const query1 = world.createQuery([positionComponent]);
      const query2 = world.createQuery([velocityComponent]);

      const entity = world.new();
      world.set(entity, positionComponent, { x: 1, y: 2 });
      world.set(entity, velocityComponent, { x: 0.1, y: 0.2 });

      world.sync();

      expect(query1.getEntities()).toEqual([entity]);
      expect(query2.getEntities()).toEqual([entity]);

      query1.dispose();

      // query1 should be disposed
      expect(query1.disposed).toBe(true);
      expect(() => query1.getEntities()).toThrow("Query has been disposed");

      // query2 should still work
      expect(query2.disposed).toBe(false);
      expect(query2.getEntities()).toEqual([entity]);
    });

    it("should get entities with component data", () => {
      const world = new World();
      const query = world.createQuery([positionComponent, velocityComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      const pos1: Position = { x: 1, y: 2 };
      const vel1: Velocity = { x: 0.1, y: 0.2 };
      const pos2: Position = { x: 3, y: 4 };
      const vel2: Velocity = { x: 0.3, y: 0.4 };

      world.set(entity1, positionComponent, pos1);
      world.set(entity1, velocityComponent, vel1);
      world.set(entity2, positionComponent, pos2);
      world.set(entity2, velocityComponent, vel2);

      world.sync();

      const results = query.getEntitiesWithComponents([positionComponent, velocityComponent]);

      expect(results.length).toBe(2);

      // Find results for each entity
      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      expect(result1!.components[0]).toEqual(pos1);
      expect(result1!.components[1]).toEqual(vel1);
      expect(result2!.components[0]).toEqual(pos2);
      expect(result2!.components[1]).toEqual(vel2);
    });

    it("should iterate over entities with forEach", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      const pos1: Position = { x: 1, y: 2 };
      const pos2: Position = { x: 3, y: 4 };

      world.set(entity1, positionComponent, pos1);
      world.set(entity2, positionComponent, pos2);

      world.sync();

      const visitedEntities: EntityId[] = [];
      const visitedPositions: Position[] = [];

      query.forEach([positionComponent], (entity, position) => {
        visitedEntities.push(entity);
        visitedPositions.push(position);
      });

      expect(visitedEntities.length).toBe(2);
      expect(visitedPositions.length).toBe(2);
      expect(visitedEntities).toContain(entity1);
      expect(visitedEntities).toContain(entity2);
      expect(visitedPositions).toContainEqual(pos1);
      expect(visitedPositions).toContainEqual(pos2);
    });

    it("should iterate over entities with iterate", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      const pos1: Position = { x: 1, y: 2 };
      const pos2: Position = { x: 3, y: 4 };

      world.set(entity1, positionComponent, pos1);
      world.set(entity2, positionComponent, pos2);

      world.sync();

      const visitedEntities: EntityId[] = [];
      const visitedPositions: Position[] = [];

      for (const [entity, position] of query.iterate([positionComponent])) {
        visitedEntities.push(entity);
        visitedPositions.push(position);
      }

      expect(visitedEntities.length).toBe(2);
      expect(visitedPositions.length).toBe(2);
      expect(visitedEntities).toContain(entity1);
      expect(visitedEntities).toContain(entity2);
      expect(visitedPositions).toContainEqual(pos1);
      expect(visitedPositions).toContainEqual(pos2);
    });

    it("should get component data arrays", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      const pos1: Position = { x: 1, y: 2 };
      const pos2: Position = { x: 3, y: 4 };

      world.set(entity1, positionComponent, pos1);
      world.set(entity2, positionComponent, pos2);

      world.sync();

      const positions = query.getComponentData(positionComponent);

      expect(positions.length).toBe(2);
      expect(positions).toContainEqual(pos1);
      expect(positions).toContainEqual(pos2);
    });

    it("should support negative components to exclude entities", () => {
      const world = new World();
      const query = world.createQuery([positionComponent], { negativeComponentTypes: [healthComponent] });

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      world.set(entity2, healthComponent, { value: 100 }); // entity2 has health, should be excluded
      world.set(entity3, healthComponent, { value: 50 }); // entity3 has no position, already excluded

      world.sync();

      const entities = query.getEntities();
      expect(entities).toContain(entity1);
      expect(entities).not.toContain(entity2);
      expect(entities).not.toContain(entity3);
    });

    it("should support wildcard relations in queries", () => {
      const world = new World();

      const tag = component();
      // Create a wildcard relation for tag component
      const wildcardTagRelation = relation(tag, "*");
      const query = world.createQuery([wildcardTagRelation]);

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, relation(tag, positionComponent), { x: 1, y: 2 });
      world.set(entity1, relation(tag, velocityComponent), { x: 0.1, y: 0.2 });

      world.set(entity2, relation(tag, positionComponent), { x: 3, y: 4 });

      // entity3 has no position component

      world.sync();

      const entities = query.getEntities();
      expect(entities).toContain(entity1);
      expect(entities).toContain(entity2);
      expect(entities).not.toContain(entity3);
    });

    it("should support mixed queries with components and wildcard relations", () => {
      const world = new World();

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 doesn't have velocity

      world.set(entity3, velocityComponent, { x: 0.5, y: 0.6 });
      // entity3 doesn't have position

      world.sync();
    });
  });

  describe("Query Caching and Reference Counting", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();

    it("should cache queries and return the same instance for identical queries", () => {
      const world = new World();

      // Create two queries with the same component types
      const query1 = world.createQuery([positionComponent]);
      const query2 = world.createQuery([positionComponent]);

      // Should return the same cached instance
      expect(query1).toBe(query2);
    });

    it("should cache queries with different component orders as the same query", () => {
      const world = new World();

      // Create queries with same components but different order
      const query1 = world.createQuery([positionComponent, velocityComponent]);
      const query2 = world.createQuery([velocityComponent, positionComponent]);

      // Should return the same cached instance (sorted internally)
      expect(query1).toBe(query2);
    });

    it("should create different queries for different component combinations", () => {
      const world = new World();

      const query1 = world.createQuery([positionComponent]);
      const query2 = world.createQuery([velocityComponent]);
      const query3 = world.createQuery([positionComponent, velocityComponent]);

      // All should be different instances
      expect(query1).not.toBe(query2);
      expect(query1).not.toBe(query3);
      expect(query2).not.toBe(query3);
    });

    it("should properly handle reference counting", () => {
      const world = new World();

      // Create multiple references to the same query
      const query1 = world.createQuery([positionComponent]);
      const query2 = world.createQuery([positionComponent]);
      const query3 = world.createQuery([positionComponent]);

      // All should be the same instance
      expect(query1).toBe(query2);
      expect(query2).toBe(query3);

      // Release all three references
      world.releaseQuery(query1);
      world.releaseQuery(query2);
      world.releaseQuery(query3);

      // Now create a new query - should be a new instance since cache was cleared
      const query4 = world.createQuery([positionComponent]);
      expect(query4).not.toBe(query1); // Should be a new instance
    });

    it("should handle releaseQuery on non-cached queries gracefully", () => {
      const world = new World();

      // Create a query and immediately release it
      const query = world.createQuery([positionComponent]);
      world.releaseQuery(query);

      // Should not throw and should create a new instance next time
      const query2 = world.createQuery([positionComponent]);
      expect(query2).not.toBe(query);
    });

    it("should cache queries with filters separately", () => {
      const world = new World();
      type Health = { value: number };
      const healthComponent = component<Health>();

      // Create queries with and without filters
      const query1 = world.createQuery([positionComponent]);
      const query2 = world.createQuery([positionComponent], { negativeComponentTypes: [healthComponent] });

      // Should be different instances due to different filters
      expect(query1).not.toBe(query2);
    });

    it("should maintain separate caches for queries with different filters", () => {
      const world = new World();
      type Health = { value: number };
      const healthComponent = component<Health>();

      // Create multiple queries with the same filter
      const query1 = world.createQuery([positionComponent], { negativeComponentTypes: [healthComponent] });
      const query2 = world.createQuery([positionComponent], { negativeComponentTypes: [healthComponent] });

      // Should return the same cached instance
      expect(query1).toBe(query2);

      // Create queries with different filters
      const query3 = world.createQuery([positionComponent], { negativeComponentTypes: [velocityComponent] });
      expect(query1).not.toBe(query3);
    });
  });

  describe("Optional Components in Queries", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };
    type Health = { value: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();
    const healthComponent = component<Health>();

    it("should handle optional components in forEach", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 has no velocity
      world.set(entity3, positionComponent, { x: 5, y: 6 });
      world.set(entity3, healthComponent, { value: 100 });

      world.sync();

      const results: Array<{ entity: EntityId; position: Position; velocity?: { value: Velocity } }> = [];

      query.forEach([positionComponent, { optional: velocityComponent }], (entity, position, velocity) => {
        results.push({ entity, position, velocity });
      });

      expect(results.length).toBe(3);

      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);
      const result3 = results.find((r) => r.entity === entity3);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result3).toBeDefined();

      expect(result1!.position).toEqual({ x: 1, y: 2 });
      expect(result1!.velocity).toEqual({ value: { x: 0.1, y: 0.2 } });

      expect(result2!.position).toEqual({ x: 3, y: 4 });
      expect(result2!.velocity).toBeUndefined();

      expect(result3!.position).toEqual({ x: 5, y: 6 });
      expect(result3!.velocity).toBeUndefined();
    });

    it("should handle optional components in getEntitiesWithComponents", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 has no velocity

      world.sync();

      const results = query.getEntitiesWithComponents([positionComponent, { optional: velocityComponent }]);

      expect(results.length).toBe(2);

      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      expect(result1!.components[0]).toEqual({ x: 1, y: 2 });
      expect(result1!.components[1]).toEqual({ value: { x: 0.1, y: 0.2 } });

      expect(result2!.components[0]).toEqual({ x: 3, y: 4 });
      expect(result2!.components[1]).toBeUndefined();
    });

    it("should handle optional components in iterate", () => {
      const world = new World();
      const query = world.createQuery([positionComponent]);

      const entity1 = world.new();
      const entity2 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });
      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 has no velocity

      world.sync();

      const results: Array<{ entity: EntityId; position: Position; velocity?: { value: Velocity } }> = [];

      for (const [entity, position, velocity] of query.iterate([positionComponent, { optional: velocityComponent }])) {
        results.push({ entity, position, velocity });
      }

      expect(results.length).toBe(2);

      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      expect(result1!.position).toEqual({ x: 1, y: 2 });
      expect(result1!.velocity).toEqual({ value: { x: 0.1, y: 0.2 } });

      expect(result2!.position).toEqual({ x: 3, y: 4 });
      expect(result2!.velocity).toBeUndefined();
    });

    it("should handle mixed mandatory and optional components", () => {
      const world = new World();
      const query = world.createQuery([positionComponent, velocityComponent]);

      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });
      world.set(entity1, healthComponent, { value: 100 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });
      world.set(entity2, velocityComponent, { x: 0.2, y: 0.3 });
      // entity2 has no health

      world.set(entity3, positionComponent, { x: 5, y: 6 });
      world.set(entity3, velocityComponent, { x: 0.3, y: 0.4 });
      world.set(entity3, healthComponent, { value: 50 });

      world.sync();

      const results: Array<{
        entity: EntityId;
        position: Position;
        velocity: Velocity;
        health?: { value: Health };
      }> = [];

      query.forEach(
        [positionComponent, velocityComponent, { optional: healthComponent }],
        (entity, position, velocity, health) => {
          results.push({ entity, position, velocity, health });
        },
      );

      expect(results.length).toBe(3);

      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);
      const result3 = results.find((r) => r.entity === entity3);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result3).toBeDefined();

      expect(result1!.position).toEqual({ x: 1, y: 2 });
      expect(result1!.velocity).toEqual({ x: 0.1, y: 0.2 });
      expect(result1!.health).toEqual({ value: { value: 100 } });

      expect(result2!.position).toEqual({ x: 3, y: 4 });
      expect(result2!.velocity).toEqual({ x: 0.2, y: 0.3 });
      expect(result2!.health).toBeUndefined();

      expect(result3!.position).toEqual({ x: 5, y: 6 });
      expect(result3!.velocity).toEqual({ x: 0.3, y: 0.4 });
      expect(result3!.health).toEqual({ value: { value: 50 } });
    });

    it("should handle optional wildcard relations", () => {
      const world = new World();

      const wildcardPositionRelation = relation(positionComponent, "*");
      const query = world.createQuery([velocityComponent]);

      const entity1 = world.new();
      const entity2 = world.new();
      const targetEntity = world.new();

      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });
      world.set(entity1, relation(positionComponent, targetEntity), { x: 1, y: 2 });

      world.set(entity2, velocityComponent, { x: 0.2, y: 0.3 });
      // entity2 has no position relation

      world.sync();

      const results: Array<{
        entity: EntityId;
        velocity: Velocity;
        positionRelation?: { value: [EntityId<unknown>, Position][] };
      }> = [];

      query.forEach(
        [velocityComponent, { optional: wildcardPositionRelation }],
        (entity, velocity, positionRelation) => {
          results.push({ entity, velocity, positionRelation });
        },
      );

      expect(results.length).toBe(2);

      const result1 = results.find((r) => r.entity === entity1);
      const result2 = results.find((r) => r.entity === entity2);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      expect(result1!.velocity).toEqual({ x: 0.1, y: 0.2 });
      expect(result1!.positionRelation).toEqual({
        value: [[targetEntity, { x: 1, y: 2 }]],
      });

      expect(result2!.velocity).toEqual({ x: 0.2, y: 0.3 });
      expect(result2!.positionRelation).toBeUndefined();
    });
  });
});
