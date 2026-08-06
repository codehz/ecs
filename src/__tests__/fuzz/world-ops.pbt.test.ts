import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { component, relation, type ComponentId, type EntityId } from "../../entity";
import type { Query } from "../../query/query";
import { World } from "../../world/world";
import { pbtAssertOptions } from "./config";

// Anonymous components (name registry is process-global).
const A = component<number>();
const B = component<number>();
const ChildOf = component({ exclusive: true, cascadeDelete: true, sparse: true });
const SparseRel = component({ exclusive: true, sparse: true });

type CompKind = "A" | "B";
type RelKind = "ChildOf" | "SparseRel";

type Op =
  | { kind: "new" }
  | { kind: "set"; idx: number; comp: CompKind; value: number }
  | { kind: "remove"; idx: number; comp: CompKind }
  | { kind: "setRel"; idx: number; targetIdx: number; rel: RelKind }
  | { kind: "removeRel"; idx: number; rel: RelKind }
  | { kind: "delete"; idx: number }
  | { kind: "sync" };

const compKindArb: fc.Arbitrary<CompKind> = fc.constantFrom("A", "B");
const relKindArb: fc.Arbitrary<RelKind> = fc.constantFrom("ChildOf", "SparseRel");

/** Generate op sequences with entity indices into a growing virtual roster. */
const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.constant({ kind: "new" as const }) },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("set" as const),
        idx: fc.nat({ max: 15 }),
        comp: compKindArb,
        value: fc.integer({ min: -100, max: 100 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("remove" as const),
        idx: fc.nat({ max: 15 }),
        comp: compKindArb,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("setRel" as const),
        idx: fc.nat({ max: 15 }),
        targetIdx: fc.nat({ max: 15 }),
        rel: relKindArb,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("removeRel" as const),
        idx: fc.nat({ max: 15 }),
        rel: relKindArb,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("delete" as const),
        idx: fc.nat({ max: 15 }),
      }),
    },
    { weight: 3, arbitrary: fc.constant({ kind: "sync" as const }) },
  ),
  { minLength: 1, maxLength: 40 },
);

function compId(kind: CompKind): ComponentId<number> {
  return kind === "A" ? A : B;
}

function relId(kind: RelKind): ComponentId {
  return kind === "ChildOf" ? ChildOf : SparseRel;
}

function pickEntity(roster: EntityId[], idx: number): EntityId | undefined {
  if (roster.length === 0) return undefined;
  return roster[idx % roster.length];
}

/**
 * Structural invariants that must hold after every sync for any legal op sequence.
 * Not a full shadow model — catches internal corruption / query drift / exclusive breaks.
 */
function assertWorldInvariants(world: World, known: EntityId[], queryA: Query): void {
  const live = known.filter((e) => world.exists(e));

  for (const e of live) {
    // has ↔ getOptional agreement for plain components
    for (const c of [A, B] as const) {
      const has = world.has(e, c);
      const opt = world.getOptional(e, c);
      if (has) {
        expect(opt).toBeDefined();
        expect(world.get(e, c)).toBe(opt!.value);
      } else {
        expect(opt).toBeUndefined();
      }
    }

    // exclusive relations: at most one concrete target
    for (const r of [ChildOf, SparseRel] as const) {
      const targets = world.getRelationTargets(e, r);
      expect(targets.length).toBeLessThanOrEqual(1);
      expect(world.countRelations(e, r)).toBe(targets.length);

      const wildcard = relation(r, "*");
      const hasWild = world.has(e, wildcard);
      expect(hasWild).toBe(targets.length > 0);

      if (targets.length === 1) {
        const [target] = targets[0]!;
        expect(world.has(e, relation(r, target))).toBe(true);
        // reverse index: if target still lives, source should appear
        if (world.exists(target)) {
          expect(world.getRelationSources(target, r)).toContain(e);
        }
      }
    }
  }

  // Query membership ≡ has(A) over live known entities
  const fromQuery = new Set(queryA.getEntities());
  for (const e of fromQuery) {
    expect(world.exists(e)).toBe(true);
    expect(world.has(e, A)).toBe(true);
  }
  for (const e of live) {
    if (world.has(e, A)) {
      expect(fromQuery.has(e)).toBe(true);
    } else {
      expect(fromQuery.has(e)).toBe(false);
    }
  }

  // cascadeDelete: no live entity may hold ChildOf pointing at a dead target
  for (const e of live) {
    for (const [target] of world.getRelationTargets(e, ChildOf)) {
      expect(world.exists(target)).toBe(true);
    }
  }
}

function assertSerializeRoundTrip(world: World, known: EntityId[]): void {
  const live = known.filter((e) => world.exists(e));
  const warn = console.warn;
  console.warn = () => {};
  let snapshot;
  try {
    snapshot = world.serialize();
  } finally {
    console.warn = warn;
  }
  const restored = new World(snapshot);

  for (const e of live) {
    expect(restored.exists(e)).toBe(true);
    for (const c of [A, B] as const) {
      expect(restored.has(e, c)).toBe(world.has(e, c));
      if (world.has(e, c)) {
        expect(restored.get(e, c)).toEqual(world.get(e, c));
      }
    }
    for (const r of [ChildOf, SparseRel] as const) {
      const before = world.getRelationTargets(e, r).map(([t, d]) => [t, d] as const);
      const after = restored.getRelationTargets(e, r).map(([t, d]) => [t, d] as const);
      expect(after).toEqual(before);
    }
  }

  // Restored world should not resurrect deleted known entities
  for (const e of known) {
    if (!world.exists(e)) {
      expect(restored.exists(e)).toBe(false);
    }
  }
}

function runOps(ops: Op[]): void {
  const world = new World();
  const queryA = world.createQuery([A]);
  const roster: EntityId[] = []; // all ever-created (including deleted)
  let dirty = false;

  const apply = (op: Op): void => {
    switch (op.kind) {
      case "new": {
        roster.push(world.new());
        dirty = true;
        break;
      }
      case "set": {
        const e = pickEntity(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        world.set(e, compId(op.comp), op.value);
        dirty = true;
        break;
      }
      case "remove": {
        const e = pickEntity(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        // remove is safe even if component absent
        world.remove(e, compId(op.comp));
        dirty = true;
        break;
      }
      case "setRel": {
        const e = pickEntity(roster, op.idx);
        const t = pickEntity(roster, op.targetIdx);
        if (e === undefined || t === undefined || !world.exists(e) || !world.exists(t)) return;
        if (e === t) return; // skip self-rel to keep cascade graphs simple
        world.set(e, relation(relId(op.rel), t));
        dirty = true;
        break;
      }
      case "removeRel": {
        const e = pickEntity(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        const targets = world.getRelationTargets(e, relId(op.rel));
        // Also clear any pending-only by removing known live targets + wildcard-less approach:
        // remove each concrete we can see; for pending exclusive set without sync, remove is best-effort.
        for (const [target] of targets) {
          world.remove(e, relation(relId(op.rel), target));
        }
        dirty = true;
        break;
      }
      case "delete": {
        const e = pickEntity(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        world.delete(e);
        dirty = true;
        break;
      }
      case "sync": {
        world.sync();
        dirty = false;
        assertWorldInvariants(world, roster, queryA);
        break;
      }
    }
  };

  for (const op of ops) {
    apply(op);
  }
  // Always finish on a clean sync so deferred buffer is applied
  if (dirty || ops[ops.length - 1]?.kind !== "sync") {
    world.sync();
  }
  assertWorldInvariants(world, roster, queryA);
  assertSerializeRoundTrip(world, roster);
}

describe("PBT: World random op sequences", () => {
  it("invariants hold after random new/set/remove/relation/delete/sync sequences", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        runOps(ops);
      }),
      // World sequences are heavier; keep CI fast but still exploratory
      { ...pbtAssertOptions, numRuns: 50 },
    );
  });

  it("exclusive relation never exceeds one target after sync", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.array(fc.tuple(fc.nat({ max: 7 }), fc.nat({ max: 7 })), { minLength: 1, maxLength: 20 }),
        (n, pairs) => {
          const world = new World();
          const entities: EntityId[] = [];
          for (let i = 0; i < n; i++) entities.push(world.new());
          world.sync();

          for (const [a, b] of pairs) {
            const e = entities[a % n]!;
            const t = entities[b % n]!;
            if (e === t) continue;
            world.set(e, relation(ChildOf, t));
          }
          world.sync();

          for (const e of entities) {
            if (!world.exists(e)) continue;
            expect(world.countRelations(e, ChildOf)).toBeLessThanOrEqual(1);
          }
        },
      ),
      pbtAssertOptions,
    );
  });
});
