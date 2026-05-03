import { describe, expect, it } from "bun:test";
import { component } from "../../entity";
import { World } from "../../world/world";

describe("Query", () => {
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
});
