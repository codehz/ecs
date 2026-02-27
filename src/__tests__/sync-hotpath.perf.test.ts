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

describe("World sync hot-path performance", () => {
  it("should keep stable sync throughput for frequent set/remove patterns", () => {
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

    const warmupRounds = 2;
    const measuredRounds = 8;

    const positionAverage = benchmark("position update + sync", warmupRounds, measuredRounds, (round) => {
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]!;
        world.set(entity, Position, { x: round, y: i });
      }
      world.sync();
    });

    const relationAverage = benchmark(
      "exclusive dontFragment relation flip + sync",
      warmupRounds,
      measuredRounds,
      (round) => {
        const target = round % 2 === 0 ? parentB : parentA;
        for (let i = 0; i < entities.length; i++) {
          const entity = entities[i]!;
          world.set(entity, relation(ChildOf, target));
        }
        world.sync();
      },
    );

    expect(world.query([Position]).length).toBe(entityCount);
    expect(world.query([relation(ChildOf, "*")]).length).toBe(entityCount);

    // Guard against pathological regressions while keeping CI variance tolerance.
    expect(positionAverage).toBeLessThan(250);
    expect(relationAverage).toBeLessThan(350);
  });
});
