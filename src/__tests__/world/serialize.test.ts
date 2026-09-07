import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../entity";
import { isSerializedWorldV2, type SerializedWorld } from "../../storage/serialization";
import { World } from "../../world/world";

function columnValue(snapshot: SerializedWorld, entityId: EntityId, typeName: string): unknown {
  if (!isSerializedWorldV2(snapshot)) return undefined;
  for (const arch of snapshot.archetypes) {
    const idx = arch.entities.indexOf(entityId);
    if (idx < 0) continue;
    const typeIndex = arch.types.indexOf(typeName);
    if (typeIndex < 0) continue;
    const col = arch.columns[typeIndex];
    if (col == null) return undefined;
    if (Array.isArray(col)) return col[idx];
    return col.u.includes(idx) ? undefined : col.v[idx];
  }
  return undefined;
}
describe("World serialization", () => {
  it("should serialize and deserialize a world with components and relations", () => {
    type Position = { x: number; y: number };

    const PositionComp = component<Position>("position");
    const HealthComp = component<number>("health");

    const world = new World();

    // Create entities
    const e1 = world.new();
    const e2 = world.new();
    const e3 = world.new();

    // Add components
    const p1: Position = { x: 1, y: 2 };
    const p2: Position = { x: 3, y: 4 };

    world.set(e1, PositionComp, p1);
    world.set(e2, PositionComp, p2);
    world.set(e2, HealthComp, 99);

    // Add relation component on e3 pointing to e1 and e2
    const relToE1 = relation(PositionComp, e1);
    const relToE2 = relation(PositionComp, e2);
    world.set(e3, relToE1, { x: 10, y: 20 });
    world.set(e3, relToE2, { x: 30, y: 40 });

    world.sync();

    // Serialize (returns an in-memory snapshot, not a JSON string)
    const snapshot = world.serialize();

    // Restore by constructing World with snapshot
    const restored = new World(snapshot);

    // Basic existence
    expect(restored.exists(e1)).toBe(true);
    expect(restored.exists(e2)).toBe(true);
    expect(restored.exists(e3)).toBe(true);

    // Components restored
    expect(restored.get(e1, PositionComp)).toEqual(p1);
    expect(restored.get(e2, PositionComp)).toEqual(p2);
    expect(restored.get(e2, HealthComp)).toEqual(99);

    // Relations restored
    expect(restored.has(e3, relToE1)).toBe(true);
    expect(restored.has(e3, relToE2)).toBe(true);

    // Wildcard query returns both relations; check contents irrespective of order
    const wildcard = relation(PositionComp, "*") as EntityId<any>;
    const relations = restored.get(e3, wildcard) as [EntityId, any][];
    const targets = relations.map((r) => r[0]);
    expect(targets).toContain(e1);
    expect(targets).toContain(e2);

    const pair1 = relations.find((r) => r[0] === e1);
    const pair2 = relations.find((r) => r[0] === e2);
    expect(pair1).toBeDefined();
    expect(pair2).toBeDefined();
    expect(pair1![1]).toEqual({ x: 10, y: 20 });
    expect(pair2![1]).toEqual({ x: 30, y: 40 });
  });

  it("should preserve entity id allocator state across serialization", () => {
    const world = new World();
    world.new();
    const b = world.new();
    world.sync();

    const snapshot = world.serialize();
    const restored = new World(snapshot);

    // Next allocated id after restore should be >= the max existing id + 1
    const c = restored.new();
    expect(c).toBeGreaterThanOrEqual(b + 1);
  });

  it("should serialize and deserialize component-relations", () => {
    const world = new World();
    const A = component<string>("A");
    const B = component<number>("B");
    const relAB = relation(A, B); // component-relation

    const e = world.new();
    world.set(e, relAB, "linked-via-comp");
    world.sync();

    const snapshot = world.serialize();
    const restored = new World(snapshot);

    expect(restored.has(e, relAB)).toBe(true);
    expect(restored.get(e, relAB)).toBe("linked-via-comp");
  });

  it("should omit skipSerialize components from snapshots", () => {
    const Position = component<{ x: number; y: number }>({ name: "SkipSerPosition" });
    const Scratch = component<{ hits: number }>({ name: "SkipSerScratch", skipSerialize: true });
    const EphemeralRel = component({ name: "SkipSerEphemeralRel", skipSerialize: true, sparse: true });

    const world = new World();
    const e = world.new();
    const target = world.new();
    world.set(e, Position, { x: 1, y: 2 });
    world.set(e, Scratch, { hits: 7 });
    world.set(e, relation(EphemeralRel, target));
    world.sync();

    expect(world.has(e, Scratch)).toBe(true);
    expect(world.has(e, relation(EphemeralRel, target))).toBe(true);

    const snapshot = world.serialize();
    const snapshotText = JSON.stringify(snapshot);
    expect(snapshotText).toContain("SkipSerPosition");
    expect(snapshotText).not.toContain("SkipSerScratch");
    expect(snapshotText).not.toContain("SkipSerEphemeralRel");

    const restored = new World(snapshot);
    expect(restored.get(e, Position)).toEqual({ x: 1, y: 2 });
    expect(restored.has(e, Scratch)).toBe(false);
    expect(restored.has(e, relation(EphemeralRel, target))).toBe(false);
  });

  it("should drop skipSerialize components present in a dirty entity snapshot", () => {
    const Position = component<{ x: number; y: number }>({ name: "SkipSerRestorePos" });
    const Scratch = component<{ hits: number }>({ name: "SkipSerRestoreScratch", skipSerialize: true });
    const EphemeralRel = component({ name: "SkipSerRestoreEphemeralRel", skipSerialize: true, sparse: true });

    const e = 1024 as EntityId;
    const target = 1025 as EntityId;

    // Hand-written snapshot still contains skipSerialize entries (legacy/dirty data).
    const snapshot = {
      version: 1,
      entityManager: { nextId: 1026 },
      entities: [
        {
          id: e,
          components: [
            { type: "SkipSerRestorePos", value: { x: 1, y: 2 } },
            { type: "SkipSerRestoreScratch", value: { hits: 7 } },
            { type: { component: "SkipSerRestoreEphemeralRel", target }, value: undefined },
          ],
        },
        {
          id: target,
          components: [],
        },
      ],
    };

    const restored = new World(snapshot);
    expect(restored.exists(e)).toBe(true);
    expect(restored.exists(target)).toBe(true);
    expect(restored.get(e, Position)).toEqual({ x: 1, y: 2 });
    expect(restored.has(e, Scratch)).toBe(false);
    expect(restored.has(e, relation(EphemeralRel, target))).toBe(false);
    expect(restored.getRelationSources(target, EphemeralRel)).toEqual([]);
  });

  it("should drop skipSerialize components present in dirty componentEntities", () => {
    const Host = component<{ v: number }>({ name: "SkipSerRestoreHost" });
    const Scratch = component<{ hits: number }>({ name: "SkipSerRestoreScratchCE", skipSerialize: true });

    const snapshot = {
      version: 1,
      entityManager: { nextId: 1024 },
      entities: [],
      componentEntities: [
        {
          id: "SkipSerRestoreHost",
          components: [
            { type: "SkipSerRestoreHost", value: { v: 42 } },
            { type: "SkipSerRestoreScratchCE", value: { hits: 3 } },
          ],
        },
      ],
    };

    const restored = new World(snapshot);
    expect(restored.singleton(Host).get()).toEqual({ v: 42 });
    expect(restored.has(Host, Scratch)).toBe(false);
  });

  it("dump should include skipSerialize components while serialize still omits them", () => {
    const Position = component<{ x: number; y: number }>({ name: "DumpSkipSerPosition" });
    const Scratch = component<{ hits: number }>({ name: "DumpSkipSerScratch", skipSerialize: true });
    const EphemeralRel = component({ name: "DumpSkipSerEphemeralRel", skipSerialize: true, sparse: true });

    const world = new World();
    const e = world.new();
    const target = world.new();
    const scratchValue = { hits: 7 };
    world.set(e, Position, { x: 1, y: 2 });
    world.set(e, Scratch, scratchValue);
    world.set(e, relation(EphemeralRel, target));
    world.sync();

    const save = world.serialize();
    const saveText = JSON.stringify(save);
    expect(saveText).toContain("DumpSkipSerPosition");
    expect(saveText).not.toContain("DumpSkipSerScratch");
    expect(saveText).not.toContain("DumpSkipSerEphemeralRel");

    const dump = world.dump();
    const dumpText = JSON.stringify(dump);
    expect(dumpText).toContain("DumpSkipSerPosition");
    expect(dumpText).toContain("DumpSkipSerScratch");
    expect(dumpText).toContain("DumpSkipSerEphemeralRel");

    expect(isSerializedWorldV2(dump)).toBe(true);
    expect(columnValue(dump, e, "DumpSkipSerScratch")).toBe(scratchValue);

    if (isSerializedWorldV2(dump)) {
      const relTable = dump.sparseRelations?.find((table) => table.component === "DumpSkipSerEphemeralRel");
      expect(relTable).toBeDefined();
      expect(relTable!.sources).toContain(e);
      expect(relTable!.targets).toContain(target);
    }
  });

  it("dump should include skipSerialize components on component-entities", () => {
    const Host = component<{ v: number }>({ name: "DumpSkipSerHost" });
    const Scratch = component<{ hits: number }>({ name: "DumpSkipSerScratchCE", skipSerialize: true });

    const world = new World();
    world.singleton(Host).set({ v: 42 });
    world.set(Host, Scratch, { hits: 3 });
    world.sync();

    const saveText = JSON.stringify(world.serialize());
    expect(saveText).toContain("DumpSkipSerHost");
    expect(saveText).not.toContain("DumpSkipSerScratchCE");

    const dump = world.dump();
    const dumpText = JSON.stringify(dump);
    expect(dumpText).toContain("DumpSkipSerScratchCE");

    const hostEntry = dump.componentEntities?.find((entry) => entry.id === "DumpSkipSerHost");
    expect(hostEntry).toBeDefined();
    const scratchEntry = hostEntry!.components.find((c) => c.type === "DumpSkipSerScratchCE");
    expect(scratchEntry?.value).toEqual({ hits: 3 });
  });

  it("emits columnar version 2 and still restores legacy version 1", () => {
    const Position = component<{ x: number; y: number }>({ name: "ColPos" });
    const ChildOf = component<void>({ name: "ColChildOf", sparse: true, exclusive: true });

    const world = new World();
    const parent = world.new();
    const child = world.new();
    world.set(parent, Position, { x: 1, y: 2 });
    world.set(child, Position, { x: 3, y: 4 });
    world.set(child, relation(ChildOf, parent));
    world.sync();

    const v2 = world.serialize();
    expect(v2.version).toBe(2);
    expect(isSerializedWorldV2(v2)).toBe(true);
    if (isSerializedWorldV2(v2)) {
      expect("entities" in v2).toBe(false);
      expect(v2.archetypes.length).toBeGreaterThan(0);
      expect(v2.sparseRelations?.some((table) => table.component === "ColChildOf")).toBe(true);
    }

    const fromV2 = new World(v2);
    expect(fromV2.get(parent, Position)).toEqual({ x: 1, y: 2 });
    expect(fromV2.get(child, Position)).toEqual({ x: 3, y: 4 });
    expect(fromV2.has(child, relation(ChildOf, parent))).toBe(true);
    expect(fromV2.getRelationSources(parent, ChildOf)).toEqual([child]);

    const v1 = world.serialize({ format: "entities" });
    expect(v1.version).toBe(1);
    expect(isSerializedWorldV2(v1)).toBe(false);
    if (!isSerializedWorldV2(v1)) {
      expect(v1.entities.length).toBe(2);
    }
    const fromV1 = new World(v1);
    expect(fromV1.get(parent, Position)).toEqual({ x: 1, y: 2 });
    expect(fromV1.has(child, relation(ChildOf, parent))).toBe(true);
  });

  it("JSON round-trips undefined and null column values", () => {
    const Optional = component<{ n: number } | undefined>({ name: "ColOptional" });
    const Nullable = component<string | null>({ name: "ColNullable" });
    const Tag = component<void>({ name: "ColTag" });

    const world = new World();
    const a = world.new();
    const b = world.new();
    world.set(a, Optional, undefined);
    world.set(a, Nullable, null);
    world.set(a, Tag);
    world.set(b, Optional, { n: 1 });
    world.set(b, Nullable, "ok");
    world.set(b, Tag);
    world.sync();

    const parsed = JSON.parse(JSON.stringify(world.serialize())) as SerializedWorld;
    const restored = new World(parsed);
    expect(restored.has(a, Optional)).toBe(true);
    expect(restored.get(a, Optional)).toBeUndefined();
    expect(restored.get(a, Nullable)).toBeNull();
    expect(restored.has(a, Tag)).toBe(true);
    expect(restored.get(b, Optional)).toEqual({ n: 1 });
    expect(restored.get(b, Nullable)).toBe("ok");
  });
});
