import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../entity";
import { isSerializedWorldV2, type SerializedWorld } from "../../storage/serialization";
import { World } from "../../world/world";

function snapshotEntityCount(snapshot: SerializedWorld): number {
  if (isSerializedWorldV2(snapshot)) {
    return snapshot.archetypes.reduce((n, arch) => n + arch.entities.length, 0);
  }
  return snapshot.entities.length;
}
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
 * Compares legacy entity-oriented snapshots (`format: "entities"`, version 1)
 * against the default columnar layout (version 2).
 *
 * Columnar wins should show up as smaller JSON and cheaper deserialize
 * (`appendEntitiesFromColumns` vs per-entity Map + addEntity).
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

    let lastV1: SerializedWorld | null = null;
    let lastV2: SerializedWorld | null = null;

    const serializeV1Avg = benchmark(`v1 serialize ${entityCount} entities (entity-oriented)`, warmup, measured, () => {
      lastV1 = world.serialize({ format: "entities" });
    });

    const serializeV2Avg = benchmark(`v2 serialize ${entityCount} entities (columnar)`, warmup, measured, () => {
      lastV2 = world.serialize();
    });

    expect(lastV1).toBeDefined();
    expect(lastV2).toBeDefined();
    expect(snapshotEntityCount(lastV1!)).toBeGreaterThanOrEqual(entityCount * 0.9);
    expect(snapshotEntityCount(lastV2!)).toBeGreaterThanOrEqual(entityCount * 0.9);
    expect(lastV2!.version).toBe(2);

    const v1Json = JSON.stringify(lastV1);
    const v2Json = JSON.stringify(lastV2);
    console.log(
      `JSON size v1=${v1Json.length} B  v2=${v2Json.length} B  ratio=${(v2Json.length / v1Json.length).toFixed(3)}  serialize v2/v1=${(serializeV2Avg / serializeV1Avg).toFixed(3)}`,
    );

    if (typeof Bun !== "undefined" && Bun.gc) {
      Bun.gc(true);
    }
    const memBefore = process.memoryUsage();
    void world.serialize();
    const memAfter = process.memoryUsage();
    const heapDeltaMB = ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2);
    console.log(
      `v2 serialize heap delta (one call): ~${heapDeltaMB} MB (rss delta: ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(2)} MB)`,
    );

    const deserializeV1Avg = benchmark(
      `v1 deserialize ${entityCount} entities (new World(v1 snapshot))`,
      warmup,
      measured,
      () => {
        const restored = new World(lastV1!);
        if (restored.exists(entities[0]!)) {
          void restored.get(entities[0]!, Position);
        }
      },
    );

    const deserializeV2Avg = benchmark(
      `v2 deserialize ${entityCount} entities (new World(v2 snapshot))`,
      warmup,
      measured,
      () => {
        const restored = new World(lastV2!);
        if (restored.exists(entities[0]!)) {
          void restored.get(entities[0]!, Position);
        }
      },
    );
    console.log(`deserialize v2/v1=${(deserializeV2Avg / deserializeV1Avg).toFixed(3)}`);

    const jsonRoundtripAvg = benchmark(
      `v2 JSON roundtrip (stringify + parse + new World) — ${entityCount} entities`,
      warmup,
      measured,
      () => {
        const json = JSON.stringify(world.serialize());
        const parsed = JSON.parse(json) as SerializedWorld;
        const restored = new World(parsed);
        if (restored.exists(entities[42]!)) {
          void restored.get(entities[42]!, Position);
        }
      },
    );

    expect(serializeV2Avg).toBeLessThan(80);
    expect(deserializeV2Avg).toBeLessThan(120);
    expect(jsonRoundtripAvg).toBeLessThan(200);
    expect(v2Json.length).toBeLessThan(v1Json.length);

    const finalRestored = new World(lastV2!);
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

    let lastV1: SerializedWorld | undefined;
    let lastV2: SerializedWorld | undefined;

    const serializeV1Avg = benchmark(
      `v1 serialize ${entityCount} entities (dense entity-relations)`,
      warmup,
      measured,
      () => {
        lastV1 = world.serialize({ format: "entities" });
      },
    );

    const serializeV2Avg = benchmark(
      `v2 serialize ${entityCount} entities (dense entity-relations)`,
      warmup,
      measured,
      () => {
        lastV2 = world.serialize();
      },
    );

    const v1Json = JSON.stringify(lastV1);
    const v2Json = JSON.stringify(lastV2);
    console.log(
      `dense JSON size v1=${v1Json.length} B  v2=${v2Json.length} B  ratio=${(v2Json.length / v1Json.length).toFixed(3)}  serialize v2/v1=${(serializeV2Avg / serializeV1Avg).toFixed(3)}`,
    );

    const deserializeV1Avg = benchmark(
      `v1 deserialize ${entityCount} entities (dense relations)`,
      warmup,
      measured,
      () => {
        void new World(lastV1!);
      },
    );
    const deserializeV2Avg = benchmark(
      `v2 deserialize ${entityCount} entities (dense relations)`,
      warmup,
      measured,
      () => {
        void new World(lastV2!);
      },
    );
    console.log(`dense deserialize v2/v1=${(deserializeV2Avg / deserializeV1Avg).toFixed(3)}`);

    expect(serializeV2Avg).toBeLessThan(150);
    expect(deserializeV2Avg).toBeLessThan(220);
  });
});
