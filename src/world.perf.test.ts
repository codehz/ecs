import { describe, it, expect } from "bun:test";
import { World } from "./world";
import { component } from "./entity";

describe("World Performance", () => {
  it("should handle archetype creation efficiently", () => {
    const world = new World();

    // Create multiple component types
    const component1 = component<{}>();
    const component2 = component<{}>();
    const component3 = component<{}>();

    // Create entities with different component combinations
    const startTime = performance.now();

    for (let i = 0; i < 100; i++) {
      const entity = world.new();
      // Add components in different combinations
      world.set(entity, component1, {});
      if (i % 2 === 0) world.set(entity, component2, {});
      if (i % 3 === 0) world.set(entity, component3, {});
    }

    world.sync();

    const endTime = performance.now();
    const duration = endTime - startTime;

    console.log(`Created 100 entities with components in ${duration.toFixed(2)}ms`);

    // Should complete in reasonable time (less than 100ms for this simple test)
    expect(duration).toBeLessThan(100);
  });

  it("should handle queries efficiently", () => {
    const world = new World();

    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };
    type Health = { value: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();
    const healthComponent = component<Health>();

    // Create many entities
    for (let i = 0; i < 1000; i++) {
      const entity = world.new();

      // Add position to all
      world.set(entity, positionComponent, { x: i, y: i });

      // Add velocity to half
      if (i % 2 === 0) {
        world.set(entity, velocityComponent, { x: 1, y: 1 });
      }

      // Add health to quarter
      if (i % 4 === 0) {
        world.set(entity, healthComponent, { value: 100 });
      }
    }

    world.sync();

    // Test query performance
    const startTime = performance.now();

    const positionEntities = world.query([positionComponent]);
    const velocityEntities = world.query([velocityComponent]);
    const healthEntities = world.query([healthComponent]);
    const positionAndVelocityEntities = world.query([positionComponent, velocityComponent]);

    const endTime = performance.now();
    const duration = endTime - startTime;

    console.log(`Queried entities in ${duration.toFixed(2)}ms`);
    console.log(`Position entities: ${positionEntities.length}`);
    console.log(`Velocity entities: ${velocityEntities.length}`);
    console.log(`Health entities: ${healthEntities.length}`);
    console.log(`Position+Velocity entities: ${positionAndVelocityEntities.length}`);

    // Verify results
    expect(positionEntities.length).toBe(1000);
    expect(velocityEntities.length).toBe(500);
    expect(healthEntities.length).toBe(250);
    expect(positionAndVelocityEntities.length).toBe(500);

    // Should complete quickly
    expect(duration).toBeLessThan(10);
  });
});
