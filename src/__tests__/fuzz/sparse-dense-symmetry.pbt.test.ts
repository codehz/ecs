import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { component, relation, type ComponentId, type EntityId } from "../../entity";
import { World } from "../../world/world";
import { pbtAssertOptions } from "./config";

/**
 * Sparse vs dense exclusive relations must agree on observable topology
 * (exists, parent, children, count, has/getOptional wildcard) for the same op stream.
 *
 * Components are module-level only — IDs are process-global and capped at 1023.
 */

const SparseExclusive = component({ exclusive: true, sparse: true });
const DenseExclusive = component({ exclusive: true });
const SparseMulti = component({ sparse: true });
const DenseMulti = component();

type Op =
  | { kind: "setRel"; child: number; parent: number }
  | { kind: "removeRel"; child: number }
  | { kind: "delete"; idx: number }
  | { kind: "recreate"; idx: number }
  | { kind: "sync" };

const opsArb: fc.Arbitrary<{ n: number; ops: Op[] }> = fc.integer({ min: 2, max: 10 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    ops: fc.array(
      fc.oneof(
        {
          weight: 4,
          arbitrary: fc.record({
            kind: fc.constant("setRel" as const),
            child: fc.nat({ max: n - 1 }),
            parent: fc.nat({ max: n - 1 }),
          }),
        },
        {
          weight: 2,
          arbitrary: fc.record({
            kind: fc.constant("removeRel" as const),
            child: fc.nat({ max: n - 1 }),
          }),
        },
        {
          weight: 2,
          arbitrary: fc.record({
            kind: fc.constant("delete" as const),
            idx: fc.nat({ max: n - 1 }),
          }),
        },
        {
          weight: 1,
          arbitrary: fc.record({
            kind: fc.constant("recreate" as const),
            idx: fc.nat({ max: n - 1 }),
          }),
        },
        { weight: 3, arbitrary: fc.constant({ kind: "sync" as const }) },
      ),
      { minLength: 1, maxLength: 40 },
    ),
  }),
);

type Snapshot = {
  alive: boolean[];
  /** parent index or -1 */
  parent: number[];
};

function capture(world: World, slots: (EntityId | null)[], Rel: ComponentId): Snapshot {
  const alive: boolean[] = [];
  const parent: number[] = [];
  const idToSlot = new Map<EntityId, number>();
  for (let i = 0; i < slots.length; i++) {
    const e = slots[i];
    if (e != null) idToSlot.set(e, i);
  }

  for (let i = 0; i < slots.length; i++) {
    const e = slots[i];
    if (e == null || !world.exists(e)) {
      alive.push(false);
      parent.push(-1);
      continue;
    }
    alive.push(true);
    const p = world.getParent(e, Rel);
    if (p === undefined) {
      parent.push(-1);
    } else {
      parent.push(idToSlot.get(p) ?? -2); // -2 = parent outside slot map (should not happen)
    }
  }
  return { alive, parent };
}

function assertTopology(world: World, slots: (EntityId | null)[], Rel: ComponentId): void {
  for (let i = 0; i < slots.length; i++) {
    const e = slots[i];
    if (e == null || !world.exists(e)) continue;

    const targets = world.getRelationTargets(e, Rel);
    expect(targets.length).toBeLessThanOrEqual(1);
    expect(world.countRelations(e, Rel)).toBe(targets.length);
    expect(world.has(e, relation(Rel, "*"))).toBe(targets.length > 0);

    if (targets.length === 1) {
      const t = targets[0]![0];
      expect(world.exists(t)).toBe(true);
      expect(world.has(e, relation(Rel, t))).toBe(true);
      expect(world.getParent(e, Rel)).toBe(t);
      expect(world.getRelationSources(t, Rel)).toContain(e);
      expect(world.getChildren(t, Rel)).toContain(e);
    }
  }

  // children lists are exactly the reverse of parent pointers among live slots
  for (let p = 0; p < slots.length; p++) {
    const parentId = slots[p];
    if (parentId == null || !world.exists(parentId)) continue;
    const kids = world.getChildren(parentId, Rel).slice().sort();
    const expected: EntityId[] = [];
    for (let c = 0; c < slots.length; c++) {
      const child = slots[c];
      if (child == null || !world.exists(child)) continue;
      if (world.getParent(child, Rel) === parentId) expected.push(child);
    }
    expect(kids).toEqual(expected.sort());
  }
}

function runPair(n: number, ops: Op[]): void {
  const sparseWorld = new World();
  const denseWorld = new World();

  const sparseSlots: (EntityId | null)[] = [];
  const denseSlots: (EntityId | null)[] = [];
  for (let i = 0; i < n; i++) {
    sparseSlots.push(sparseWorld.new());
    denseSlots.push(denseWorld.new());
  }
  sparseWorld.sync();
  denseWorld.sync();

  const apply = (world: World, slots: (EntityId | null)[], Rel: ComponentId, op: Op): void => {
    switch (op.kind) {
      case "setRel": {
        const child = slots[op.child];
        const parent = slots[op.parent];
        if (child == null || parent == null) return;
        if (!world.exists(child) || !world.exists(parent)) return;
        if (child === parent) return;
        world.set(child, relation(Rel, parent));
        break;
      }
      case "removeRel": {
        const child = slots[op.child];
        if (child == null || !world.exists(child)) return;
        for (const [t] of world.getRelationTargets(child, Rel)) {
          world.remove(child, relation(Rel, t));
        }
        break;
      }
      case "delete": {
        const e = slots[op.idx];
        if (e == null || !world.exists(e)) return;
        world.delete(e);
        break;
      }
      case "recreate": {
        // Only recreate if currently dead — keeps slot indices aligned across worlds.
        const e = slots[op.idx];
        if (e != null && world.exists(e)) return;
        slots[op.idx] = world.new();
        break;
      }
      case "sync":
        world.sync();
        break;
    }
  };

  for (const op of ops) {
    apply(sparseWorld, sparseSlots, SparseExclusive, op);
    apply(denseWorld, denseSlots, DenseExclusive, op);
    if (op.kind === "sync") {
      assertTopology(sparseWorld, sparseSlots, SparseExclusive);
      assertTopology(denseWorld, denseSlots, DenseExclusive);
      const s = capture(sparseWorld, sparseSlots, SparseExclusive);
      const d = capture(denseWorld, denseSlots, DenseExclusive);
      expect(d).toEqual(s);
    }
  }
  sparseWorld.sync();
  denseWorld.sync();
  assertTopology(sparseWorld, sparseSlots, SparseExclusive);
  assertTopology(denseWorld, denseSlots, DenseExclusive);
  expect(capture(denseWorld, denseSlots, DenseExclusive)).toEqual(capture(sparseWorld, sparseSlots, SparseExclusive));
}

describe("PBT: sparse vs dense exclusive relation symmetry", () => {
  it("same op stream yields identical parent/child topology", () => {
    fc.assert(
      fc.property(opsArb, ({ n, ops }) => {
        runPair(n, ops);
      }),
      { ...pbtAssertOptions, numRuns: 50 },
    );
  });

  it("non-exclusive multi-target sparse and dense stay multi-edge consistent", () => {
    // Non-exclusive: many targets allowed; still has↔sources agreement per mode.
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        fc.array(fc.tuple(fc.nat({ max: 7 }), fc.nat({ max: 7 })), { minLength: 1, maxLength: 25 }),
        (n, pairs) => {
          for (const Rel of [SparseMulti, DenseMulti]) {
            const world = new World();
            const entities: EntityId[] = [];
            for (let i = 0; i < n; i++) entities.push(world.new());
            world.sync();

            const expected = new Map<EntityId, Set<EntityId>>();
            for (const e of entities) expected.set(e, new Set());

            for (const [a, b] of pairs) {
              const src = entities[a % n]!;
              const tgt = entities[b % n]!;
              if (src === tgt) continue;
              world.set(src, relation(Rel, tgt));
              expected.get(src)!.add(tgt);
            }
            world.sync();

            for (const e of entities) {
              if (!world.exists(e)) continue;
              const got = new Set(world.getRelationTargets(e, Rel).map(([t]) => t));
              expect(got).toEqual(expected.get(e)!);
              expect(world.countRelations(e, Rel)).toBe(got.size);
              expect(world.has(e, relation(Rel, "*"))).toBe(got.size > 0);
              for (const t of got) {
                expect(world.getRelationSources(t, Rel)).toContain(e);
              }
            }
          }
        },
      ),
      pbtAssertOptions,
    );
  });
});
