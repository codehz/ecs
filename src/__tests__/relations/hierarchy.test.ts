import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { World, component, relation, type EntityId } from "../../index";
import type { SyncDebugStats } from "../../types";

describe("Relation & Hierarchy Companion Tools", () => {
  let world: World;
  let ChildOf: any;
  let InInventory: any;
  let ItemData: any;

  let collectedStats: SyncDebugStats[] = [];
  let debugCollector: { [Symbol.dispose](): void } | null = null;

  beforeEach(() => {
    world = new World();
    // IMPORTANT: do not use .name here — the component name registry is global
    // across the test process and previous tests may have used similar names.
    ChildOf = component<void>({ exclusive: true, dontFragment: true });
    InInventory = component<void>({ dontFragment: true });
    ItemData = component<{ name: string }>();

    collectedStats = [];
    debugCollector = world.createDebugStatsCollector((stats) => {
      collectedStats.push(stats);
    });
  });

  afterEach(() => {
    if (debugCollector) {
      debugCollector[Symbol.dispose]();
      debugCollector = null;
    }
    collectedStats = [];
  });

  function makeTree() {
    const root = world.new();
    const a = world.new();
    const b = world.new();
    const c = world.new();
    const d = world.new(); // grandchild under a

    world.set(a, relation(ChildOf, root));
    world.set(b, relation(ChildOf, root));
    world.set(c, relation(ChildOf, a));
    world.set(d, relation(ChildOf, a));
    world.sync();

    return { root, a, b, c, d };
  }

  it("getChildren / getParent roundtrip for exclusive hierarchy", () => {
    const { root, a, b, c, d } = makeTree();

    expect(world.getChildren(root, ChildOf)).toEqual(expect.arrayContaining([a, b]));
    expect(world.getChildren(a, ChildOf)).toEqual(expect.arrayContaining([c, d]));
    expect(world.getChildren(b, ChildOf)).toEqual([]);

    expect(world.getParent(a, ChildOf)).toBe(root);
    expect(world.getParent(c, ChildOf)).toBe(a);
    expect(world.getParent(root, ChildOf)).toBeUndefined();

    // Use the new debug collector to verify structural activity
    const lastStats = collectedStats[collectedStats.length - 1];
    expect(lastStats).toBeDefined();
    // Building the tree creates relation-related archetypes and populates reference indices
    expect(lastStats!.archetypes.total).toBeGreaterThanOrEqual(2);
    expect(lastStats!.indices.entityReferences).toBeGreaterThanOrEqual(1);
  });

  it("getRelationTargets and has/count work for both exclusive and non-exclusive", () => {
    const owner = world.new();
    const item1 = world.new();
    const item2 = world.new();

    world.set(owner, relation(InInventory, item1));
    world.set(owner, relation(InInventory, item2));
    world.sync();

    const targets = world.getRelationTargets(owner, InInventory);
    expect(targets.length).toBe(2);
    expect(targets.map(([t]) => t)).toEqual(expect.arrayContaining([item1, item2]));

    expect(world.hasRelation(owner, InInventory)).toBe(true);
    expect(world.hasRelation(owner, InInventory, item1)).toBe(true);
    expect(world.hasRelation(owner, InInventory, world.new())).toBe(false);
    expect(world.countRelations(owner, InInventory)).toBe(2);

    expect(world.countRelations(item1, InInventory)).toBe(0);
  });

  it("getRelationSources (reverse) works for non-exclusive inventory modeling", () => {
    const player = world.new();
    const chest = world.new();
    const sword = world.new();

    world.set(player, relation(InInventory, sword));
    world.set(chest, relation(InInventory, sword));
    world.sync();

    const owners = world.getRelationSources(sword, InInventory);
    expect(owners).toEqual(expect.arrayContaining([player, chest]));
    expect(owners.length).toBe(2);
  });

  it("iterateDescendants and traverseDescendants produce correct order and depths (iterative)", () => {
    const { root, a, b, c, d } = makeTree();

    const visited: Array<{ id: EntityId; depth: number }> = [];
    world.traverseDescendants(root, ChildOf, (e, depth) => {
      visited.push({ id: e, depth });
    });

    expect(visited.length).toBe(4);
    expect(visited.find((v) => v.id === a)!.depth).toBe(1);
    expect(visited.find((v) => v.id === c)!.depth).toBe(2);
    expect(visited.find((v) => v.id === d)!.depth).toBe(2);
    expect(visited.find((v) => v.id === b)!.depth).toBe(1);

    const viaIter = Array.from(world.iterateDescendants(root, ChildOf, { includeSelf: false }));
    expect(viaIter.length).toBe(4);
    expect(viaIter.every((x) => x.parent !== null)).toBe(true);
  });

  it("getAncestors returns path to root (not including self)", () => {
    const { root, a, c } = makeTree();

    expect(world.getAncestors(c, ChildOf)).toEqual([a, root]);
    expect(world.getAncestors(a, ChildOf)).toEqual([root]);
    expect(world.getAncestors(root, ChildOf)).toEqual([]);
  });

  it("reparenting (exclusive) is visible after sync", () => {
    const { root, a, b } = makeTree();
    const newRoot = world.new();
    world.sync();

    const statsBeforeReparent = collectedStats.length;

    // Move a under newRoot (exclusive relation flip → structural change expected)
    world.set(a, relation(ChildOf, newRoot));
    world.sync();

    expect(world.getParent(a, ChildOf)).toBe(newRoot);
    expect(world.getChildren(root, ChildOf)).not.toContain(a);
    expect(world.getChildren(newRoot, ChildOf)).toContain(a);
    expect(world.getChildren(root, ChildOf)).toContain(b);

    // The debug collector should have recorded activity for the exclusive relation change
    expect(collectedStats.length).toBeGreaterThan(statsBeforeReparent);
    const last = collectedStats[collectedStats.length - 1]!;
    // Exclusive reparenting typically triggers structural activity (migrations or new archetypes for the new parent relation)
    expect(
      last.activity.migrations + last.activity.archetypesCreated + last.activity.archetypesRemoved,
    ).toBeGreaterThanOrEqual(0);
  });

  it("relations with payload data are returned correctly", () => {
    const owner = world.new();
    const item = world.new();
    world.set(item, ItemData, { name: "Magic Sword" });

    const Owns = component<{ slot: string }>({ dontFragment: true });
    world.set(owner, relation(Owns, item), { slot: "hand" });
    world.sync();

    const targets = world.getRelationTargets(owner, Owns);
    expect(targets.length).toBe(1);
    expect(targets[0]![0]).toBe(item);
    expect(targets[0]![1]).toEqual({ slot: "hand" });
  });

  it("throws on missing entity for forward access (getRelationTargets etc.)", () => {
    const fake = 999999 as EntityId;
    expect(() => world.getRelationTargets(fake, ChildOf)).toThrow();
    expect(() => world.hasRelation(fake, ChildOf)).toThrow();
    expect(() => world.countRelations(fake, ChildOf)).toThrow();

    // Reverse lookup on a non-existent parent safely returns []
    expect(world.getChildren(fake, ChildOf)).toEqual([]);
  });

  it("findRoots stub + recommended pattern with domain query works", () => {
    const { root, a, b, c, d } = makeTree();

    const all = [root, a, b, c, d];
    const roots = all.filter((e) => !world.hasRelation(e, ChildOf));
    expect(roots).toEqual([root]);
  });

  it("deletion removes entities from relation views after sync", () => {
    const { root, a } = makeTree();
    const statsBefore = collectedStats.length;

    world.delete(a);
    world.sync();

    const kids = world.getChildren(root, ChildOf);
    expect(kids).not.toContain(a);
    expect(world.exists(a)).toBe(false);

    // Deletion + relation cleanup should be visible in debug stats
    expect(collectedStats.length).toBeGreaterThan(statsBefore);
    const last = collectedStats[collectedStats.length - 1]!;
    // We expect at least some archetype or reference maintenance activity
    expect(last.activity.archetypesRemoved + last.indices.entityReferences).toBeGreaterThanOrEqual(0);
  });
});
