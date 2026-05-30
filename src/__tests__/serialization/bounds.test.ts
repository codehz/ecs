import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../../entity";
import { decodeSerializedId, encodeEntityId, encodeEntityIdCached } from "../../storage/serialization";
import { World } from "../../world/world";

describe("Serialization edge cases", () => {
  it("should serialize empty world", () => {
    const world = new World();
    const snapshot = world.serialize();

    expect(snapshot.entities).toHaveLength(0);
    expect(snapshot.version).toBeDefined();

    const newWorld = new World(snapshot);
    expect(newWorld.exists(-1 as unknown as ReturnType<typeof world.new>)).toBe(false);
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

  it("should serialize and deserialize singleton components (covers componentEntities paths)", () => {
    const world = new World();
    const Config = component<{ debug: boolean }>();
    // Singleton shorthand populates internal component entity
    world.set(Config, { debug: true });
    world.sync();

    const snapshot = world.serialize();
    const restored = new World(snapshot);

    expect(restored.has(Config)).toBe(true);
    expect(restored.get(Config)).toEqual({ debug: true });
  });

  it("should round-trip anonymous (no-name) components in entity-relations and component-relations", () => {
    const world = new World();
    const A = component<{ v: number }>(); // anonymous -> triggers numeric fallback + warn paths
    const B = component<string>(); // also anonymous for target in comp-rel
    const e1 = world.new();
    const e2 = world.new();
    const relE = relation(A, e1);
    const relC = relation(A, B);
    world.set(e2, relE, { v: 42 });
    world.set(e2, relC, { v: 99 });
    world.sync();

    const snap = world.serialize();
    const r = new World(snap);

    expect(r.has(e2, relE)).toBe(true);
    expect(r.get(e2, relE)).toEqual({ v: 42 });
    expect(r.has(e2, relC)).toBe(true);
    expect(r.get(e2, relC)).toEqual({ v: 99 });
  });

  describe("Serialization ID codec (low-level, covers all decode/encode branches)", () => {
    it("should exercise cache hit/miss and no-cache path in encodeEntityIdCached", () => {
      const C = component<number>();
      const cache = new Map();
      const c1 = encodeEntityIdCached(C, cache);
      const c2 = encodeEntityIdCached(C, cache);
      expect(c2).toBe(c1); // hit
      const noCache = encodeEntityIdCached(C); // else branch (no cache provided)
      expect(noCache).toBeDefined();
      // also wrapper
      expect(encodeEntityId(C)).toBeDefined();
    });

    it("should round-trip all relation kinds including wildcard via encode/decode", () => {
      const C = component<boolean>();
      const E = 9999 as EntityId<any>;
      const relE = relation(C, E);
      const C2 = component<string>();
      const relC = relation(C, C2);
      const wild = relation(C, "*");

      expect(decodeSerializedId(encodeEntityId(relE))).toBe(relE);
      expect(decodeSerializedId(encodeEntityId(relC))).toBe(relC);
      expect(decodeSerializedId(encodeEntityId(wild))).toBe(wild);
    });

    it("should hit numeric string fallbacks and all error throws in decode", () => {
      const C1 = component<number>();
      const C2 = component<string>();
      const id1 = C1 as unknown as number;
      const id2 = C2 as unknown as number;

      // numeric fallback paths (when name lookup fails; use real allocated IDs as strings)
      expect(decodeSerializedId(String(id1) as any)).toBe(id1 as any);
      expect(decodeSerializedId({ component: String(id2), target: 99999 } as any)).toBeDefined(); // component-relation numeric fallback; creates valid relation(C2, fakeTarget)

      // error paths (unknown names hit throws before relation() ctor)
      expect(() => decodeSerializedId("TotallyUnknownName!!" as any)).toThrow(/Unknown component name in snapshot/);
      expect(() => decodeSerializedId({ component: "BadName", target: 1 } as any)).toThrow(
        /Unknown component name in snapshot/,
      );
      expect(() => decodeSerializedId({ component: "123", target: "BadTargetName" } as any)).toThrow(
        /Unknown target component name in snapshot/,
      );
      expect(() => decodeSerializedId({ foo: "bar" } as any)).toThrow(/Invalid ID in snapshot/);
    });
  });

  describe("Entity-ID-as-componentType references (ad-hoc entity refs)", () => {
    it("should round-trip worlds using raw EntityIds as component types (covers 'entity' branch in deserialize reference tracking)", () => {
      const world = new World();

      const eTarget = world.new();
      const eHolder = world.new();

      // Use a raw entity ID (>= ENTITY_ID_START) directly as a component "type".
      // This models an untyped/ad-hoc reference to another entity.
      // The value is omitted (void presence-only component).
      world.set(eHolder, eTarget as unknown as EntityId<any>);
      world.sync();

      const snapshot = world.serialize();
      const restored = new World(snapshot);

      expect(restored.exists(eTarget)).toBe(true);
      expect(restored.exists(eHolder)).toBe(true);

      // The ad-hoc component must survive the roundtrip.
      expect(restored.has(eHolder, eTarget as unknown as EntityId<any>)).toBe(true);
    });
  });

  describe("ComponentEntities deserialization guards", () => {
    it("should ignore componentEntities snapshot entries whose id is not a real component entity (covers continue guard)", () => {
      const world = new World();
      const Config = component<{ debug: boolean }>();
      world.set(Config, { debug: true });
      world.sync();

      const snap: any = world.serialize();

      // Inject a bogus entry: a high ordinary entity id (never a component entity)
      const bogus = 123456 as EntityId;
      snap.componentEntities = snap.componentEntities || [];
      snap.componentEntities.push({
        id: bogus,
        components: [{ type: 99, value: "should-be-ignored" }],
      });

      const restored = new World(snap);

      // Real singleton still works; bogus entry was skipped without error
      expect(restored.has(Config)).toBe(true);
      expect(restored.get(Config)).toEqual({ debug: true });
    });
  });
});
