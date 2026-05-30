import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

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

/**
 * Serialization performance benchmarks.
 *
 * These benchmarks validate the post-optimization serialization path
 * (see optimization plan for src/world/serialization.ts):
 *
 * Key optimizations exercised:
 * - Column-oriented direct export from Archetype (bypasses per-entity Map + dump())
 * - Per-archetype pre-encoding of component type IDs
 * - ID encoding cache (encodeEntityIdCached) for repeated component/relation IDs
 * - Removal of redundant per-entity work in deserialization
 *
 * Target scale: 8k–12k entities across multiple archetypes + relations.
 * This is large enough to show meaningful differences while keeping test runtime reasonable.
 */
describe("Serialization performance (post-optimization baseline)", () => {
  it("should serialize and deserialize large mixed worlds efficiently", () => {
    const world = new World();

    // Named components (realistic serialization path with name lookup)
    const Position = component<{ x: number; y: number }>("Position");
    const Velocity = component<{ vx: number; vy: number }>("Velocity");
    const Health = component<{ hp: number; maxHp: number }>("Health");
    const Name = component<{ value: string }>("Name");
    const Inventory = component<{ items: string[] }>("Inventory");

    // Entity-valued component (creates entity references)
    const Target = component<{ entity: EntityId }>("Target");

    // Relations
    const ChildOf = component<void>("ChildOf");

    const entityCount = 12_000;
    const entities: EntityId[] = [];

    // Distribute entities across several archetypes for realistic archetype diversity
    // Archetype A: Position + Velocity + Health
    // Archetype B: Position + Name + Inventory
    // Archetype C: Position + Velocity + Target (entity-valued component)
    // Archetype D: Position only (minimal)

    const parents: EntityId[] = [];

    for (let i = 0; i < entityCount; i++) {
      const entity = world.new();
      entities.push(entity);

      const archetypeKind = i % 4;

      world.set(entity, Position, { x: i, y: i * 2 });

      if (archetypeKind === 0) {
        // Archetype A
        world.set(entity, Velocity, { vx: 1, vy: 0.5 });
        world.set(entity, Health, { hp: 100, maxHp: 100 });
      } else if (archetypeKind === 1) {
        // Archetype B
        world.set(entity, Name, { value: `Entity-${i}` });
        world.set(entity, Inventory, { items: ["sword", "potion"] });
      } else if (archetypeKind === 2) {
        // Archetype C — has entity reference
        world.set(entity, Velocity, { vx: 0.2, vy: -1 });
        // Point to a previous entity (creates realistic entity-valued component)
        const targetIdx = Math.max(0, i - 7);
        world.set(entity, Target, { entity: entities[targetIdx]! });
      } else {
        // Archetype D — minimal
        // Only Position
      }

      // Every 17th entity becomes a parent and gets some children via relations
      if (i % 17 === 0) {
        parents.push(entity);
      }
    }

    // Add relations (ChildOf) — creates entity-relation IDs that must be encoded
    for (let i = 0; i < entityCount; i++) {
      const parentIdx = Math.floor(i / 8) % Math.max(1, parents.length);
      const parent = parents[parentIdx] ?? entities[0]!;
      if (parent !== entities[i]) {
        world.set(entities[i]!, relation(ChildOf, parent));
      }
    }

    world.sync();

    expect(entities.length).toBe(entityCount);

    const warmup = 2;
    const measured = 5;

    // === Serialize ===
    let lastSnapshot: ReturnType<World["serialize"]> | null = null;

    const serializeAvg = benchmark(
      `serialize ${entityCount} entities (mixed archetypes + relations)`,
      warmup,
      measured,
      () => {
        lastSnapshot = world.serialize();
      },
    );

    expect(lastSnapshot).toBeDefined();
    expect(lastSnapshot!.entities.length).toBeGreaterThanOrEqual(entityCount * 0.9); // rough sanity

    // Measure rough heap impact of a serialize call.
    // Note: Bun may require --smol or explicit GC for more stable allocation numbers.
    if (typeof Bun !== "undefined" && Bun.gc) {
      Bun.gc(true);
    }
    const memBefore = process.memoryUsage();
    void world.serialize();
    const memAfter = process.memoryUsage();
    const heapDeltaMB = ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2);
    console.log(
      `serialize heap delta (one call): ~${heapDeltaMB} MB (rss delta: ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(2)} MB)`,
    );

    // === Deserialize (new World from snapshot) ===
    const deserializeAvg = benchmark(
      `deserialize ${entityCount} entities (new World(snapshot))`,
      warmup,
      measured,
      () => {
        // We create and immediately let go of the world to measure allocation + construction cost
        const restored = new World(lastSnapshot!);
        // Touch one value to prevent dead-code elimination in theory
        if (restored.exists(entities[0]!)) {
          void restored.get(entities[0]!, Position);
        }
      },
    );

    // === Full JSON roundtrip (very common user pattern) ===
    const jsonRoundtripAvg = benchmark(
      `full JSON roundtrip (stringify + parse + new World) — ${entityCount} entities`,
      warmup,
      measured,
      () => {
        const json = JSON.stringify(world.serialize());
        const parsed = JSON.parse(json);
        const restored = new World(parsed);
        if (restored.exists(entities[42]!)) {
          void restored.get(entities[42]!, Position);
        }
      },
    );

    // Loose upper bounds — these act as regression guards.
    // The numbers are intentionally generous to account for CI machine variance.
    // The main value is the detailed console output for manual before/after comparison.
    expect(serializeAvg).toBeLessThan(80); // ~12k entities serialize
    expect(deserializeAvg).toBeLessThan(120); // new World(snapshot) tends to be heavier
    expect(jsonRoundtripAvg).toBeLessThan(200); // includes JSON + full deserialize

    // Final sanity: the last deserialized world should still have most entities
    const finalRestored = new World(lastSnapshot!);
    expect(finalRestored.exists(entities[0]!)).toBe(true);
    expect(finalRestored.exists(entities[entityCount - 1]!)).toBe(true);
  });

  it("should handle worlds with heavy entity-relation usage", () => {
    const world = new World();

    const Position = component<{ x: number; y: number }>("Pos");
    const Owes = component<{ amount: number }>("Owes"); // used for relations

    const entityCount = 8_000;
    const entities: EntityId[] = [];

    for (let i = 0; i < entityCount; i++) {
      const e = world.new();
      entities.push(e);
      world.set(e, Position, { x: i, y: i });
    }

    // Create a dense web of entity-relations (every entity owes 3 others)
    for (let i = 0; i < entityCount; i++) {
      for (let j = 1; j <= 3; j++) {
        const target = entities[(i + j * 17) % entityCount]!;
        if (target !== entities[i]) {
          world.set(entities[i]!, relation(Owes, target), { amount: (i + j) % 100 });
        }
      }
    }

    world.sync();

    const warmup = 1;
    const measured = 4;

    const serializeAvg = benchmark(
      `serialize ${entityCount} entities (dense entity-relations)`,
      warmup,
      measured,
      () => {
        void world.serialize();
      },
    );

    // Deserialize with many relations exercises decode + reference tracking
    let snapshot: ReturnType<World["serialize"]> | undefined;

    const deserializeAvg = benchmark(`deserialize ${entityCount} entities (dense relations)`, warmup, measured, () => {
      if (!snapshot) snapshot = world.serialize();
      const w = new World(snapshot);
      void w;
    });

    // Very loose bounds — this scenario is intentionally expensive
    expect(serializeAvg).toBeLessThan(150);
    expect(deserializeAvg).toBeLessThan(220);
  });
});
