import { describe, expect, it } from "bun:test";
import { component } from "../core/entity";
import { World } from "../core/world";

describe("CommandBuffer iteration limit", () => {
  it("should throw when exceeding MAX_ITERATIONS", () => {
    const world = new World();
    const Counter = component<{ value: number }>();

    // Create a hook that recursively increments a counter
    world.hook(Counter, {
      on_set: (entityId, componentType, data) => {
        // Keep triggering new set commands beyond the iteration limit
        if (data.value < 200) {
          world.set(entityId, componentType, { value: data.value + 1 });
        }
      },
    });

    const entity = world.new();
    world.set(entity, Counter, { value: 0 });

    // Executing should exceed iteration limit and throw
    expect(() => world.sync()).toThrow(/maximum.*iterations|exceeded/i);
  });

  it("should handle multiple entities with cascading commands", () => {
    const world = new World();
    const Increment = component<{ count: number }>();

    let hookCalls = 0;
    world.hook(Increment, {
      on_set: (entityId, componentType, data) => {
        hookCalls++;
        // Only trigger new commands on first few calls to avoid exceeding limit
        // We have 2 entities, each initial set + cascading calls
        if (hookCalls < 25) {
          world.set(entityId, componentType, { count: data.count + 1 });
        }
      },
    });

    const entity1 = world.new();
    const entity2 = world.new();

    world.set(entity1, Increment, { count: 0 });
    world.set(entity2, Increment, { count: 0 });

    // This should complete without reaching the iteration limit (100)
    world.sync();
    expect(hookCalls).toBeGreaterThan(0);
    expect(hookCalls).toBeLessThan(100);
  });

  it("should execute all commands within iteration limit", () => {
    const world = new World();
    const Value = component<{ num: number }>();

    const entity = world.new();

    // Queue multiple commands before sync
    for (let i = 0; i < 50; i++) {
      world.set(entity, Value, { num: i });
    }

    // Should complete without throwing
    world.sync();

    // Final value should be the last one set
    expect(world.get(entity, Value)).toEqual({ num: 49 });
  });
});
