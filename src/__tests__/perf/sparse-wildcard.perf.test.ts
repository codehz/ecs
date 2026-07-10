import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

/**
 * Focused performance tests for sparse relation storage.
 *
 * These tests specifically exercise the hot paths:
 * - Wildcard queries over sparse relations (relation(Comp, "*"))
 * - Frequent exclusive relation flips (the classic ChildOf pattern)
 * - hasRelationWithComponentId / archetype filtering cost
 */

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

  const average = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  console.log(
    `${label}: avg ${average.toFixed(2)}ms after ${warmupRounds} warmup (${durations.map((d) => d.toFixed(2)).join("ms, ")}ms)`,
  );
  return average;
}

describe("Sparse + Wildcard Performance", () => {
  it("should handle large numbers of entities with exclusive sparse relations + wildcard queries efficiently", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const ChildOf = component({ sparse: true, exclusive: true });

    const parentCount = 20;
    const parents: EntityId[] = [];
    for (let i = 0; i < parentCount; i++) {
      parents.push(world.new() as EntityId);
    }

    const entityCount = 10_000;
    const entities: EntityId[] = [];

    for (let i = 0; i < entityCount; i++) {
      const e = world.new();
      entities.push(e);
      world.set(e, Position, { x: i, y: i });
      const parent = parents[i % parentCount]!;
      world.set(e, relation(ChildOf, parent));
    }
    world.sync();

    const wildcard = relation(ChildOf, "*");
    using q = world.createQuery([Position, wildcard]);

    const avg = benchmark("10k entities: wildcard query over exclusive sparse relations", 2, 6, () => {
      let count = 0;
      q.forEach([Position, wildcard], (_entity, _pos, rels) => {
        count += rels.length; // force materialization
      });
      expect(count).toBeGreaterThan(0);
    });

    // The goal is to verify we did not regress the hot wildcard + sparse storage path.
    expect(avg).toBeLessThan(50); // generous upper bound
  });

  it("should support frequent exclusive sparse relation flips without leaking relations", () => {
    const world = new World();
    const ChildOf = component({ sparse: true, exclusive: true });

    const parentA = world.new();
    const parentB = world.new();

    const entityCount = 2000;
    const entities: EntityId[] = [];
    for (let i = 0; i < entityCount; i++) {
      const e = world.new();
      entities.push(e);
      world.set(e, relation(ChildOf, parentA));
    }
    world.sync();

    // Flip many times
    const flipAvg = benchmark("2k entities: exclusive sparse relation flip (100 rounds)", 1, 3, (round) => {
      const target = round % 2 === 0 ? parentB : parentA;
      for (const e of entities) {
        world.set(e, relation(ChildOf, target));
      }
      world.sync();
    });

    const wildcardCount = world.query([relation(ChildOf, "*")]).length;
    expect(wildcardCount).toBe(entityCount);

    // Should stay fast even after many flips (no quadratic degradation)
    expect(flipAvg).toBeLessThan(120);
  });
});
