import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../core/entity";
import { World } from "../core/world";

function benchmark(label: string, warmupRounds: number, measuredRounds: number, fn: (round: number) => void): number {
  const durations: number[] = [];

  const totalRounds = warmupRounds + measuredRounds;
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    fn(round);
    const duration = performance.now() - start;
    if (round >= warmupRounds) {
      durations.push(duration);
    }
  }

  const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  console.log(
    `${label}: avg ${average.toFixed(2)}ms after ${warmupRounds} warmup rounds (${durations
      .map((d) => d.toFixed(2))
      .join("ms, ")}ms per measured round)`,
  );
  return average;
}

describe("Comprehensive ECS performance benchmarks", () => {
  /**
   * Benchmark 1: Component set (no structural change) - hot path for data updates
   * This is the most common operation: updating a component value without archetype migration
   */
  it("should handle many component value updates efficiently", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const Velocity = component<{ vx: number; vy: number }>();

    const entityCount = 10_000;
    const entities: EntityId[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Position, { x: i, y: i });
      world.set(entity, Velocity, { vx: 1, vy: 1 });
    }
    world.sync();

    // Single component update
    const singleCompAvg = benchmark("10k entities: single component update + sync", 2, 6, (round) => {
      for (let i = 0; i < entities.length; i++) {
        world.set(entities[i]!, Position, { x: round, y: i });
      }
      world.sync();
    });

    // Two component update
    const twoCompAvg = benchmark("10k entities: two component updates + sync", 2, 6, (round) => {
      for (let i = 0; i < entities.length; i++) {
        world.set(entities[i]!, Position, { x: round, y: i });
        world.set(entities[i]!, Velocity, { vx: round, vy: i });
      }
      world.sync();
    });

    expect(singleCompAvg).toBeLessThan(300);
    expect(twoCompAvg).toBeLessThan(500);
  });

  /**
   * Benchmark 2: Structural archetype migrations - entities moving between archetypes
   * These are more expensive than value updates because of array manipulation
   */
  it("should handle archetype migrations efficiently", () => {
    const world = new World();
    const Alive = component<void>();
    const Dead = component<void>();

    const entityCount = 4000;
    const entities: EntityId[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Alive);
    }
    world.sync();

    // Add/remove components causing archetype migration
    const migrationAvg = benchmark("4k entities: archetype migration (add/remove) + sync", 2, 6, (round) => {
      if (round % 2 === 0) {
        for (let i = 0; i < entities.length; i++) {
          world.set(entities[i]!, Dead);
        }
      } else {
        for (let i = 0; i < entities.length; i++) {
          world.remove(entities[i]!, Dead);
        }
      }
      world.sync();
    });

    expect(migrationAvg).toBeLessThan(300);
  });

  /**
   * Benchmark 3: Query iteration - the inner loop of ECS systems
   * This is the absolute hot path - should be very fast
   */
  it("should iterate over queries efficiently", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const Velocity = component<{ vx: number; vy: number }>();

    const entityCount = 10_000;
    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      world.set(entity, Position, { x: i, y: i });
      world.set(entity, Velocity, { vx: 1, vy: 1 });
    }
    world.sync();

    const movementQuery = world.createQuery([Position, Velocity]);

    // Pure iteration (no writes)
    const readAvg = benchmark("10k entities: forEach read-only query", 2, 6, () => {
      let count = 0;
      movementQuery.forEach([Position, Velocity], (_entity, _pos, _vel) => {
        count++;
      });
      expect(count).toBe(entityCount);
    });

    // Read and modify in place (no sync needed for non-structural)
    let sumX = 0;
    const updateAvg = benchmark("10k entities: forEach query with accumulation", 2, 6, () => {
      sumX = 0;
      movementQuery.forEach([Position, Velocity], (_entity, pos, vel) => {
        sumX += pos.x + vel.vx;
      });
    });

    movementQuery.dispose();

    console.log(`Sum X (to prevent optimization): ${sumX}`);
    expect(readAvg).toBeLessThan(20);
    expect(updateAvg).toBeLessThan(20);
  });

  /**
   * Benchmark 4: Entity spawn and sync - creating entities
   */
  it("should spawn and sync entities efficiently", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const Velocity = component<{ vx: number; vy: number }>();

    const entityCount = 1000;

    const spawnAvg = benchmark("1k entity spawn + 2 components + sync", 2, 6, () => {
      const entities: EntityId[] = [];
      for (let i = 0; i < entityCount; i++) {
        const entity = world.new();
        entities.push(entity);
        world.set(entity, Position, { x: i, y: i });
        world.set(entity, Velocity, { vx: 1, vy: 1 });
      }
      world.sync();
      // Cleanup
      for (const entity of entities) {
        world.delete(entity);
      }
      world.sync();
    });

    expect(spawnAvg).toBeLessThan(150);
  });

  /**
   * Benchmark 5: Mixed operations - realistic game loop simulation
   * Some entities update, some spawn, some die - typical game scenario
   */
  it("should handle mixed operations in a realistic game loop", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const Health = component<number>();
    const Alive = component<void>();

    const initialCount = 2000;
    const entities: EntityId[] = [];

    for (let i = 0; i < initialCount; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Position, { x: i, y: i });
      world.set(entity, Health, 100);
      world.set(entity, Alive);
    }
    world.sync();

    const movementQuery = world.createQuery([Position, Health]);

    const mixedAvg = benchmark("2k entities: mixed ops (update 90%, spawn 5%, delete 5%) + sync", 2, 6, (round) => {
      const deleteCount = Math.floor(entities.length * 0.05);
      const spawnCount = deleteCount;

      // Update most entities
      movementQuery.forEach([Position, Health], (entity, pos, health) => {
        world.set(entity, Position, { x: pos.x + 1, y: pos.y + 1 });
        world.set(entity, Health, health - 1);
      });

      // Delete some
      for (let i = 0; i < deleteCount && entities.length > 0; i++) {
        const idx = (round * deleteCount + i) % entities.length;
        world.delete(entities[idx]!);
        entities.splice(idx, 1);
      }

      // Spawn some
      for (let i = 0; i < spawnCount; i++) {
        const entity = world.new();
        entities.push(entity);
        world.set(entity, Position, { x: i, y: i });
        world.set(entity, Health, 100);
        world.set(entity, Alive);
      }

      world.sync();
    });

    movementQuery.dispose();
    expect(mixedAvg).toBeLessThan(300);
  });

  /**
   * Benchmark 6: CommandBuffer grouping overhead
   * Tests the overhead of the Map grouping in execute()
   * This specifically targets the new Map() allocation per sync call
   */
  it("should execute command buffer efficiently with many commands", () => {
    const world = new World();
    const A = component<number>();
    const B = component<number>();
    const C = component<number>();

    const entityCount = 5000;
    const entities: EntityId[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, A, i);
      world.set(entity, B, i * 2);
    }
    world.sync();

    // Many commands per sync - tests command buffer grouping
    const manyCommandsAvg = benchmark("5k entities: 3 commands each + sync (15k total commands)", 2, 6, (round) => {
      for (let i = 0; i < entities.length; i++) {
        world.set(entities[i]!, A, round + i);
        world.set(entities[i]!, B, round - i);
        world.set(entities[i]!, C, round * i);
      }
      world.sync();
    });

    expect(manyCommandsAvg).toBeLessThan(600);
  });

  /**
   * Benchmark 7: dontFragment relation updates (the existing benchmark scenario)
   */
  it("should handle dontFragment exclusive relation flips efficiently", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const ChildOf = component({ dontFragment: true, exclusive: true });

    const parentA = world.new();
    const parentB = world.new();

    const entityCount = 4000;
    const entities: EntityId[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Position, { x: i, y: i });
      world.set(entity, relation(ChildOf, parentA));
    }
    world.sync();

    const relationFlipAvg = benchmark("4k entities: exclusive dontFragment relation flip + sync", 2, 8, (round) => {
      const target = round % 2 === 0 ? parentB : parentA;
      for (let i = 0; i < entities.length; i++) {
        world.set(entities[i]!, relation(ChildOf, target));
      }
      world.sync();
    });

    expect(world.query([Position]).length).toBe(entityCount);
    expect(world.query([relation(ChildOf, "*")]).length).toBe(entityCount);
    expect(relationFlipAvg).toBeLessThan(350);
  });
});
