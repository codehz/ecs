import { describe, it, expect } from "bun:test";
import { World } from "./world";
import { createComponentId } from "./entity";

describe("World Performance", () => {
  it("should handle archetype creation efficiently", () => {
    const world = new World();

    // Create multiple component types
    const component1 = createComponentId<{}>(1);
    const component2 = createComponentId<{}>(2);
    const component3 = createComponentId<{}>(3);

    // Create entities with different component combinations
    const startTime = performance.now();

    for (let i = 0; i < 100; i++) {
      const entity = world.createEntity();
      // Add components in different combinations
      world.addComponent(entity, component1, {});
      if (i % 2 === 0) world.addComponent(entity, component2, {});
      if (i % 3 === 0) world.addComponent(entity, component3, {});
    }

    world.flushCommands();

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

    const positionComponent = createComponentId<Position>(1);
    const velocityComponent = createComponentId<Velocity>(2);
    const healthComponent = createComponentId<Health>(3);

    // Create many entities
    for (let i = 0; i < 1000; i++) {
      const entity = world.createEntity();

      // Add position to all
      world.addComponent(entity, positionComponent, { x: i, y: i });

      // Add velocity to half
      if (i % 2 === 0) {
        world.addComponent(entity, velocityComponent, { x: 1, y: 1 });
      }

      // Add health to quarter
      if (i % 4 === 0) {
        world.addComponent(entity, healthComponent, { value: 100 });
      }
    }

    world.flushCommands();

    // Test query performance
    const startTime = performance.now();

    const positionEntities = world.queryEntities([positionComponent]);
    const velocityEntities = world.queryEntities([velocityComponent]);
    const healthEntities = world.queryEntities([healthComponent]);
    const positionAndVelocityEntities = world.queryEntities([positionComponent, velocityComponent]);

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
