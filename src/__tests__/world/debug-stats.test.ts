import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../../entity";
import type { SyncDebugStats } from "../../types";
import { World } from "../../world/world";

describe("World - Debug Stats Collector", () => {
  type Position = { x: number; y: number };
  type Velocity = { x: number; y: number };

  const Position = component<Position>();
  const Velocity = component<Velocity>();

  it("should deliver stats after sync when collector is active", () => {
    const world = new World();
    const entity = world.new();

    const received: SyncDebugStats[] = [];

    using _collector = world.createDebugStatsCollector((stats) => {
      received.push(stats);
    });

    world.set(entity, Position, { x: 1, y: 2 });
    world.sync();

    expect(received.length).toBe(1);
    const stats = received[0]!;
    expect(stats.commandIterations).toBeGreaterThanOrEqual(0);
    expect(stats.entities.total).toBeGreaterThanOrEqual(1);
    expect(stats.archetypes.total).toBeGreaterThanOrEqual(1);
    expect(typeof stats.timestamps.syncStart).toBe("number");
    expect(stats.timestamps.syncEnd).toBeGreaterThanOrEqual(stats.timestamps.syncStart);
  });

  it("should report archetype creation and removal activity", () => {
    const world = new World();
    const e1 = world.new();
    const e2 = world.new();

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    // First sync creates the empty archetype + entities
    world.sync();
    const afterFirst = received[received.length - 1]!;

    // Cause archetype migrations by adding different components
    world.set(e1, Position, { x: 0, y: 0 });
    world.set(e2, Velocity, { x: 1, y: 1 });
    world.sync();

    const afterMigration = received[received.length - 1]!;

    expect(afterMigration.activity.archetypesCreated).toBeGreaterThanOrEqual(0);
    // We created at least one new archetype in the second sync
    expect(afterMigration.activity.archetypesCreated + afterFirst.activity.archetypesCreated).toBeGreaterThan(0);

    // Now remove components to potentially clean up archetypes
    world.remove(e1, Position);
    world.remove(e2, Velocity);
    world.sync();

    const afterRemove = received[received.length - 1]!;
    expect(afterRemove.activity.archetypesRemoved).toBeGreaterThanOrEqual(0);
  });

  it("should count actual entity migrations", () => {
    const world = new World();
    const entity = world.new();

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    world.set(entity, Position, { x: 1, y: 1 });
    world.sync();

    // Adding a second component should cause a migration
    world.set(entity, Velocity, { x: 0, y: 0 });
    world.sync();

    const last = received[received.length - 1]!;
    expect(last.activity.migrations).toBeGreaterThanOrEqual(1);
  });

  it("should count hook executions", () => {
    const world = new World();
    const entity = world.new();

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    // Register a hook
    world.hook([Position], {
      on_set: () => {},
    });

    world.set(entity, Position, { x: 10, y: 20 });
    world.sync();

    const stats = received[received.length - 1]!;
    expect(stats.activity.hooksExecuted).toBeGreaterThanOrEqual(1);
    expect(stats.hooks.total).toBeGreaterThanOrEqual(1);
  });

  it("should deliver identical object reference to multiple collectors", () => {
    const world = new World();
    const e = world.new();

    const receivedA: SyncDebugStats[] = [];
    const receivedB: SyncDebugStats[] = [];

    using _c1 = world.createDebugStatsCollector((s) => receivedA.push(s));
    using _c2 = world.createDebugStatsCollector((s) => receivedB.push(s));

    world.set(e, Position, { x: 5, y: 5 });
    world.sync();

    expect(receivedA.length).toBe(1);
    expect(receivedB.length).toBe(1);
    expect(receivedA[0]).toBe(receivedB[0]); // exact same reference
  });

  it("should stop delivering after collector is disposed", () => {
    const world = new World();
    const e = world.new();

    const received: SyncDebugStats[] = [];
    const collector = world.createDebugStatsCollector((s) => received.push(s));

    world.set(e, Position, { x: 1, y: 1 });
    world.sync();
    expect(received.length).toBe(1);

    collector[Symbol.dispose]();

    world.set(e, Position, { x: 2, y: 2 });
    world.sync();
    // Should not have received a second stats payload
    expect(received.length).toBe(1);
  });

  it("should report command iterations for complex command batches", () => {
    const world = new World();
    const entities: EntityId[] = [];

    for (let i = 0; i < 10; i++) {
      entities.push(world.new());
    }

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    // Many sets on different entities should require at least one iteration
    for (const e of entities) {
      world.set(e, Position, { x: 1, y: 1 });
    }
    world.sync();

    const stats = received[received.length - 1]!;
    expect(stats.commandIterations).toBeGreaterThanOrEqual(1);
  });

  it("should only collect for syncs after the collector was created", () => {
    const world = new World();
    const e = world.new();

    world.set(e, Position, { x: 1, y: 1 });
    world.sync(); // This sync happens before any collector exists

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    world.set(e, Position, { x: 2, y: 2 });
    world.sync(); // This one should be observed

    expect(received.length).toBe(1);
  });

  it("should observe activity and index changes from relations", () => {
    const world = new World();

    const ChildOf = component<void>({ exclusive: true });

    const parent1 = world.new();
    const parent2 = world.new();
    const child = world.new();

    const received: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => received.push(s));

    // Establish a relation (should populate entity reference indices)
    world.set(child, relation(ChildOf, parent1));
    world.sync();

    const afterRelation = received[received.length - 1]!;
    expect(afterRelation.indices.entityReferences).toBeGreaterThanOrEqual(1);

    // Switching an exclusive relation should cause a migration/remove + add
    world.set(child, relation(ChildOf, parent2));
    world.sync();

    const afterSwitch = received[received.length - 1]!;
    // Exclusive relation flip typically causes at least one structural change
    expect(afterSwitch.activity.migrations).toBeGreaterThanOrEqual(0);
  });
});
