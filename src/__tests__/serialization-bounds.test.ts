import { describe, expect, it } from "bun:test";
import { component, type EntityId } from "../core/entity";
import { World } from "../core/world";

describe("Serialization edge cases", () => {
  it("should serialize empty world", () => {
    const world = new World();
    const snapshot = world.serialize();

    expect(snapshot.entities).toHaveLength(0);
    expect(snapshot.version).toBeDefined();

    const newWorld = new World(snapshot);
    expect(newWorld.exists(-1)).toBe(false);
  });

  it("should serialize and deserialize single entity", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const entity = world.new();

    world.set(entity, Position, { x: 10, y: 20 });
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.exists(entity)).toBe(true);
    expect(newWorld.get(entity, Position)).toEqual({ x: 10, y: 20 });
  });

  it("should serialize world with many entities", () => {
    const world = new World();
    const Value = component<{ id: number }>();

    const entities: EntityId[] = [];
    // Create 100 entities
    for (let i = 0; i < 100; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Value, { id: i });
    }
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    // Verify all entities exist
    for (let i = 0; i < entities.length; i++) {
      expect(newWorld.exists(entities[i]!)).toBe(true);
      const data = newWorld.get(entities[i]!, Value);
      expect(data.id).toBe(i);
    }
  });

  it("should serialize multiple components per entity", () => {
    const world = new World();
    const Position = component<{ x: number; y: number }>();
    const Velocity = component<{ dx: number; dy: number }>();
    const Health = component<{ hp: number }>();

    const entity = world.new();
    world.set(entity, Position, { x: 1, y: 2 });
    world.set(entity, Velocity, { dx: 3, dy: 4 });
    world.set(entity, Health, { hp: 100 });
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.get(entity, Position)).toEqual({ x: 1, y: 2 });
    expect(newWorld.get(entity, Velocity)).toEqual({ dx: 3, dy: 4 });
    expect(newWorld.get(entity, Health)).toEqual({ hp: 100 });
  });

  it("should handle circular entity references in serialization", () => {
    const world = new World();
    const Ref = component<{ ref: EntityId }>();

    const e1 = world.new();
    const e2 = world.new();

    world.set(e1, Ref, { ref: e2 });
    world.set(e2, Ref, { ref: e1 });
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.exists(e1)).toBe(true);
    expect(newWorld.exists(e2)).toBe(true);

    // Verify circular references are preserved
    const ref1 = newWorld.get(e1, Ref).ref;
    const ref2 = newWorld.get(e2, Ref).ref;

    // References should be maintained
    expect(ref1).toBe(e2);
    expect(ref2).toBe(e1);
  });

  it("should serialize with void components", () => {
    const world = new World();
    const Tag = component<void>();
    const entity = world.new();

    world.set(entity, Tag);
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.has(entity, Tag)).toBe(true);
  });

  it("should serialize with undefined component values", () => {
    const world = new World();
    const Optional = component<{ value: number } | undefined>();
    const entity = world.new();

    world.set(entity, Optional, undefined);
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.has(entity, Optional)).toBe(true);
    expect(newWorld.get(entity, Optional)).toBeUndefined();
  });

  it("should round-trip serialization", () => {
    const world1 = new World();
    const Data = component<{ x: number; y: number }>();

    const entities: EntityId[] = [];
    for (let i = 0; i < 10; i++) {
      const entity = world1.new();
      entities.push(entity);
      world1.set(entity, Data, { x: i, y: i * 2 });
    }
    world1.sync();

    // First serialization
    const snapshot1 = world1.serialize();
    const world2 = new World(snapshot1);

    // Second serialization
    const snapshot2 = world2.serialize();

    // Snapshots should be equivalent
    expect(snapshot1.entities).toHaveLength(snapshot2.entities.length);
    expect(snapshot1.version).toBe(snapshot2.version);

    // Verify data is preserved
    for (const entity of entities) {
      expect(world2.get(entity, Data)).toBeDefined();
    }
  });

  it("should preserve entity existence across serialization", () => {
    const world = new World();
    const Dummy = component<any>();

    const entities: EntityId[] = [];
    for (let i = 0; i < 50; i++) {
      const entity = world.new();
      entities.push(entity);
      world.set(entity, Dummy, { num: i });
    }
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    // All entities should exist in new world
    for (const entity of entities) {
      expect(newWorld.exists(entity)).toBe(true);
    }
  });

  it("should handle mixed component types in serialization", () => {
    const world = new World();
    const String = component<string>();
    const Number = component<number>();
    const Boolean = component<boolean>();
    const Object = component<{ nested: { value: number } }>();

    const entity = world.new();
    world.set(entity, String, "test");
    world.set(entity, Number, 42);
    world.set(entity, Boolean, true);
    world.set(entity, Object, { nested: { value: 123 } });
    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    expect(newWorld.get(entity, String)).toBe("test");
    expect(newWorld.get(entity, Number)).toBe(42);
    expect(newWorld.get(entity, Boolean)).toBe(true);
    expect(newWorld.get(entity, Object)).toEqual({ nested: { value: 123 } });
  });

  it("should serialize entities with different archetypes", () => {
    const world = new World();
    const Position = component<{ x: number }>();
    const Velocity = component<{ vx: number }>();

    // Entity with both components
    const e1 = world.new();
    world.set(e1, Position, { x: 10 });
    world.set(e1, Velocity, { vx: 5 });

    // Entity with only Position
    const e2 = world.new();
    world.set(e2, Position, { x: 20 });

    // Entity with only Velocity
    const e3 = world.new();
    world.set(e3, Velocity, { vx: 15 });

    world.sync();

    const snapshot = world.serialize();
    const newWorld = new World(snapshot);

    // Verify all entities and their components
    expect(newWorld.get(e1, Position)).toEqual({ x: 10 });
    expect(newWorld.get(e1, Velocity)).toEqual({ vx: 5 });

    expect(newWorld.get(e2, Position)).toEqual({ x: 20 });
    expect(newWorld.has(e2, Velocity)).toBe(false);

    expect(newWorld.has(e3, Position)).toBe(false);
    expect(newWorld.get(e3, Velocity)).toEqual({ vx: 15 });
  });
});
