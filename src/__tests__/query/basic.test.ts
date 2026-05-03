import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

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
});
