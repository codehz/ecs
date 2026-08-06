import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";
import { pbtAssertOptions } from "./config";

/**
 * Same-frame command folding / exclusive last-wins / destroy-wins.
 * Oracle is a pure per-entity shadow map, not "doesn't throw".
 */

const A = component<number>();
const B = component<number>();
const ExclusiveSparse = component({ exclusive: true, sparse: true });
const ExclusiveDense = component({ exclusive: true });
/** Extra pair for the multi-set property (must not allocate per run). */
const MultiSparse = component({ exclusive: true, sparse: true });
const MultiDense = component({ exclusive: true });

type Comp = "A" | "B";
type Rel = "sparse" | "dense";

type FrameOp =
  | { kind: "set"; e: number; comp: Comp; value: number }
  | { kind: "remove"; e: number; comp: Comp }
  | { kind: "setRel"; e: number; target: number; rel: Rel }
  | { kind: "removeRel"; e: number; rel: Rel }
  | { kind: "delete"; e: number };

type Frame = FrameOp[];

const compArb: fc.Arbitrary<Comp> = fc.constantFrom("A", "B");
const relArb: fc.Arbitrary<Rel> = fc.constantFrom("sparse", "dense");

function frameOpArb(n: number): fc.Arbitrary<FrameOp> {
  const idx = fc.nat({ max: Math.max(0, n - 1) });
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("set" as const),
        e: idx,
        comp: compArb,
        value: fc.integer({ min: -50, max: 50 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("remove" as const),
        e: idx,
        comp: compArb,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("setRel" as const),
        e: idx,
        target: idx,
        rel: relArb,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("removeRel" as const),
        e: idx,
        rel: relArb,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("delete" as const),
        e: idx,
      }),
    },
  );
}

/** Sequence of frames; each frame is flushed with one sync. */
const scenarioArb = fc.integer({ min: 2, max: 8 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    frames: fc.array(fc.array(frameOpArb(n), { minLength: 1, maxLength: 12 }), {
      minLength: 1,
      maxLength: 6,
    }),
  }),
);

type ShadowEntity = {
  alive: boolean;
  A?: number;
  B?: number;
  sparseParent?: number;
  denseParent?: number;
};

function emptyShadow(n: number): ShadowEntity[] {
  return Array.from({ length: n }, () => ({ alive: true }));
}

/**
 * Apply one frame's ops to the shadow.
 * Mirrors CommandBuffer two-phase flush + ComponentChangeset folding:
 * - structural set/remove for non-destroyed entities first
 * - destroy drops the whole per-entity batch
 * - edges to targets that die this frame are stripped after destroy
 * - setRel to an *already-dead* target is a no-op (runner checks exists())
 */
function applyFrameShadow(state: ShadowEntity[], ops: Frame): void {
  const byEntity = new Map<number, FrameOp[]>();
  for (const op of ops) {
    const list = byEntity.get(op.e) ?? [];
    list.push(op);
    byEntity.set(op.e, list);
  }

  // Alive at frame start — used to decide whether setRel is issuable.
  const aliveAtStart = state.map((s) => s.alive);
  const diesThisFrame = new Set<number>();
  for (const [e, entityOps] of byEntity) {
    if (aliveAtStart[e] && entityOps.some((op) => op.kind === "delete")) {
      diesThisFrame.add(e);
    }
  }

  // Phase 1: structural folds for entities that are not destroyed this frame.
  for (const [e, entityOps] of byEntity) {
    if (!aliveAtStart[e] || diesThisFrame.has(e)) continue;
    const ent = state[e]!;

    for (const op of entityOps) {
      switch (op.kind) {
        case "set":
          ent[op.comp] = op.value;
          break;
        case "remove":
          delete ent[op.comp];
          break;
        case "setRel": {
          if (op.e === op.target) break;
          // Runner only enqueues when world.exists(target) — i.e. alive at frame start.
          if (!aliveAtStart[op.target]) break;
          if (op.rel === "sparse") ent.sparseParent = op.target;
          else ent.denseParent = op.target;
          break;
        }
        case "removeRel":
          if (op.rel === "sparse") delete ent.sparseParent;
          else delete ent.denseParent;
          break;
      }
    }
  }

  // Phase 2: destroy wins for entities with a delete in this frame.
  for (const e of diesThisFrame) {
    const ent = state[e]!;
    ent.alive = false;
    delete ent.A;
    delete ent.B;
    delete ent.sparseParent;
    delete ent.denseParent;
  }

  // Phase 3: reverse-ref cleanup — no live edge may point at a dead target.
  for (const ent of state) {
    if (!ent.alive) continue;
    if (ent.sparseParent !== undefined) {
      const t = state[ent.sparseParent];
      if (t === undefined || !t.alive) delete ent.sparseParent;
    }
    if (ent.denseParent !== undefined) {
      const t = state[ent.denseParent];
      if (t === undefined || !t.alive) delete ent.denseParent;
    }
  }
}

function assertMatchesWorld(world: World, entities: EntityId[], state: ShadowEntity[]): void {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    const s = state[i]!;
    expect(world.exists(e)).toBe(s.alive);
    if (!s.alive) continue;

    for (const [comp, id] of [
      ["A", A],
      ["B", B],
    ] as const) {
      const expected = s[comp];
      if (expected === undefined) {
        expect(world.has(e, id)).toBe(false);
        expect(world.getOptional(e, id)).toBeUndefined();
      } else {
        expect(world.has(e, id)).toBe(true);
        expect(world.get(e, id)).toBe(expected);
        expect(world.getOptional(e, id)!.value).toBe(expected);
      }
    }

    const sparseParent = s.sparseParent;
    const denseParent = s.denseParent;
    const sparseTargets = world.getRelationTargets(e, ExclusiveSparse).map(([t]) => t);
    const denseTargets = world.getRelationTargets(e, ExclusiveDense).map(([t]) => t);

    if (sparseParent === undefined) {
      expect(sparseTargets).toEqual([]);
      expect(world.countRelations(e, ExclusiveSparse)).toBe(0);
    } else {
      expect(sparseTargets).toEqual([entities[sparseParent]!]);
      expect(world.getParent(e, ExclusiveSparse)).toBe(entities[sparseParent]!);
      expect(world.has(e, relation(ExclusiveSparse, entities[sparseParent]!))).toBe(true);
    }

    if (denseParent === undefined) {
      expect(denseTargets).toEqual([]);
      expect(world.countRelations(e, ExclusiveDense)).toBe(0);
    } else {
      expect(denseTargets).toEqual([entities[denseParent]!]);
      expect(world.getParent(e, ExclusiveDense)).toBe(entities[denseParent]!);
      expect(world.has(e, relation(ExclusiveDense, entities[denseParent]!))).toBe(true);
    }
  }

  // Reverse index agreement for exclusive parents.
  for (let p = 0; p < entities.length; p++) {
    if (!state[p]!.alive) continue;
    const parent = entities[p]!;
    const expectedSparseChildren = state
      .map((s, i) => (s.alive && s.sparseParent === p ? entities[i]! : undefined))
      .filter((x): x is EntityId => x !== undefined)
      .sort();
    const expectedDenseChildren = state
      .map((s, i) => (s.alive && s.denseParent === p ? entities[i]! : undefined))
      .filter((x): x is EntityId => x !== undefined)
      .sort();
    expect([...world.getChildren(parent, ExclusiveSparse)].sort()).toEqual(expectedSparseChildren);
    expect([...world.getChildren(parent, ExclusiveDense)].sort()).toEqual(expectedDenseChildren);
  }
}

function runScenario(n: number, frames: Frame[]): void {
  const world = new World();
  const entities: EntityId[] = [];
  for (let i = 0; i < n; i++) entities.push(world.new());
  world.sync();

  const state = emptyShadow(n);

  for (const frame of frames) {
    // Track same-frame exclusive sets so removeRel can cancel pending targets
    // (getRelationTargets only sees post-sync state).
    const pendingSparse = new Map<EntityId, EntityId>();
    const pendingDense = new Map<EntityId, EntityId>();

    for (const op of frame) {
      const e = entities[op.e];
      if (e === undefined || !world.exists(e)) continue;
      switch (op.kind) {
        case "set":
          world.set(e, op.comp === "A" ? A : B, op.value);
          break;
        case "remove":
          world.remove(e, op.comp === "A" ? A : B);
          break;
        case "setRel": {
          const t = entities[op.target];
          if (t === undefined || !world.exists(t) || e === t) break;
          if (op.rel === "sparse") {
            world.set(e, relation(ExclusiveSparse, t));
            pendingSparse.set(e, t);
          } else {
            world.set(e, relation(ExclusiveDense, t));
            pendingDense.set(e, t);
          }
          break;
        }
        case "removeRel": {
          const rel = op.rel === "sparse" ? ExclusiveSparse : ExclusiveDense;
          const pending = op.rel === "sparse" ? pendingSparse : pendingDense;
          const targets = new Set<EntityId>();
          for (const [target] of world.getRelationTargets(e, rel)) targets.add(target);
          const p = pending.get(e);
          if (p !== undefined) targets.add(p);
          for (const target of targets) {
            world.remove(e, relation(rel, target));
          }
          pending.delete(e);
          break;
        }
        case "delete":
          world.delete(e);
          break;
      }
    }
    world.sync();
    applyFrameShadow(state, frame);
    assertMatchesWorld(world, entities, state);
  }
}

describe("PBT: same-frame command folding", () => {
  it("plain set/remove last-op-wins and exclusive last target match shadow", () => {
    fc.assert(
      fc.property(scenarioArb, ({ n, frames }) => {
        runScenario(n, frames);
      }),
      { ...pbtAssertOptions, numRuns: 50 },
    );
  });

  it("set then remove in one frame leaves component absent", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (value) => {
        const world = new World();
        const e = world.new();
        world.set(e, A, value);
        world.remove(e, A);
        world.sync();
        expect(world.has(e, A)).toBe(false);
        expect(world.getOptional(e, A)).toBeUndefined();
      }),
      pbtAssertOptions,
    );
  });

  it("remove then set in one frame leaves final value", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }), (v1, v2) => {
        const world = new World();
        const e = world.new();
        world.set(e, A, v1);
        world.sync();
        world.remove(e, A);
        world.set(e, A, v2);
        world.sync();
        expect(world.get(e, A)).toBe(v2);
      }),
      pbtAssertOptions,
    );
  });

  it("exclusive multi-set same frame: last target wins (sparse + dense)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 10 }),
        (n, targetIdxs) => {
          for (const Rel of [MultiSparse, MultiDense]) {
            const world = new World();
            const entities: EntityId[] = [];
            for (let i = 0; i < n; i++) entities.push(world.new());
            world.sync();

            const child = entities[0]!;
            let last: EntityId | undefined;
            for (const ti of targetIdxs) {
              const t = entities[1 + (ti % (n - 1))]!;
              world.set(child, relation(Rel, t));
              last = t;
            }
            world.sync();

            expect(world.countRelations(child, Rel)).toBe(1);
            expect(world.getParent(child, Rel)).toBe(last);
            for (let i = 1; i < n; i++) {
              const p = entities[i]!;
              if (p === last) {
                expect(world.getChildren(p, Rel)).toEqual([child]);
              } else {
                expect(world.getChildren(p, Rel)).toEqual([]);
              }
            }
          }
        },
      ),
      pbtAssertOptions,
    );
  });
});
