import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

describe("Query", () => {
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
