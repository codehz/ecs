import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { component, relation, EntityIdManager, ENTITY_ID_START, type EntityId } from "../../entity";
import { World } from "../../world/world";
import { pbtAssertOptions } from "./config";

/**
 * Freelist reuse: EntityIdManager LIFO model + World recycled IDs must not
 * inherit prior components / reverse refs.
 */

type AllocOp = { kind: "alloc" } | { kind: "free"; idx: number };

const allocOpsArb: fc.Arbitrary<AllocOp[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.constant({ kind: "alloc" as const }) },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("free" as const),
        idx: fc.nat({ max: 31 }),
      }),
    },
  ),
  { minLength: 1, maxLength: 60 },
);

/** Pure LIFO freelist shadow for EntityIdManager. */
class ModelIdManager {
  nextId = ENTITY_ID_START;
  freelist: number[] = [];
  live = new Set<number>();

  allocate(): number {
    if (this.freelist.length > 0) {
      const id = this.freelist.pop()!;
      this.live.add(id);
      return id;
    }
    const id = this.nextId++;
    this.live.add(id);
    return id;
  }

  deallocate(id: number): void {
    if (!this.live.has(id)) {
      // Manager throws only on invalid/never-allocated; double-free is not checked.
      // World never double-frees; model only frees live IDs.
      return;
    }
    this.live.delete(id);
    this.freelist.push(id);
  }
}

function runIdManagerOps(ops: AllocOp[]): void {
  const real = new EntityIdManager();
  const model = new ModelIdManager();
  const roster: number[] = [];

  for (const op of ops) {
    if (op.kind === "alloc") {
      const a = Number(real.allocate());
      const b = model.allocate();
      expect(a).toBe(b);
      roster.push(a);
    } else {
      if (roster.length === 0) continue;
      const id = roster[op.idx % roster.length]!;
      // Only free if model still considers it live (avoid double-free noise).
      if (!model.live.has(id)) continue;
      real.deallocate(id as EntityId);
      model.deallocate(id);
    }
  }

  expect(real.getFreelistSize()).toBe(model.freelist.length);
  expect(real.getNextId()).toBe(model.nextId);
  expect(real.serializeState()).toEqual({
    nextId: model.nextId,
    freelist: [...model.freelist],
  });
}

// --- World-level recycle safety ---

const Pos = component<{ x: number }>();
const Tag = component();
const Link = component({ sparse: true });
const DenseLink = component({ exclusive: true });
const Cascade = component({ exclusive: true, cascadeDelete: true, sparse: true });

type WorldOp =
  | { kind: "new" }
  | { kind: "setPos"; idx: number; x: number }
  | { kind: "setTag"; idx: number }
  | { kind: "setLink"; idx: number; targetIdx: number; dense: boolean }
  | { kind: "setCascade"; idx: number; targetIdx: number }
  | { kind: "delete"; idx: number }
  | { kind: "sync" };

const worldOpsArb: fc.Arbitrary<WorldOp[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.constant({ kind: "new" as const }) },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("setPos" as const),
        idx: fc.nat({ max: 15 }),
        x: fc.integer({ min: -20, max: 20 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("setTag" as const),
        idx: fc.nat({ max: 15 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("setLink" as const),
        idx: fc.nat({ max: 15 }),
        targetIdx: fc.nat({ max: 15 }),
        dense: fc.boolean(),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("setCascade" as const),
        idx: fc.nat({ max: 15 }),
        targetIdx: fc.nat({ max: 15 }),
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
  { minLength: 2, maxLength: 40 },
);

function pick(roster: EntityId[], idx: number): EntityId | undefined {
  if (roster.length === 0) return undefined;
  return roster[idx % roster.length];
}

/**
 * After any sync: every live entity's components must only be those set since
 * its *current life* (tracked by generation). Recycled IDs start empty.
 */
function runWorldRecycleOps(ops: WorldOp[]): void {
  const world = new World();
  const roster: EntityId[] = [];
  /** generation per roster slot; increments on each recycle of that id */
  const genOfId = new Map<EntityId, number>();
  /** expected payload for current generation of each live id */
  type State = {
    pos?: number;
    tag?: boolean;
    sparseLink?: EntityId;
    denseLink?: EntityId;
    cascade?: EntityId;
  };
  const state = new Map<EntityId, State>();

  const ensureState = (e: EntityId): State => {
    let s = state.get(e);
    if (s === undefined) {
      s = {};
      state.set(e, s);
    }
    return s;
  };

  const apply = (op: WorldOp): void => {
    switch (op.kind) {
      case "new": {
        const e = world.new();
        // Recycled ids must not duplicate roster entries (LIFO reuse).
        if (!roster.includes(e)) roster.push(e);
        genOfId.set(e, (genOfId.get(e) ?? 0) + 1);
        state.set(e, {}); // recycled or brand new: empty
        break;
      }
      case "setPos": {
        const e = pick(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        world.set(e, Pos, { x: op.x });
        ensureState(e).pos = op.x;
        break;
      }
      case "setTag": {
        const e = pick(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        world.set(e, Tag);
        ensureState(e).tag = true;
        break;
      }
      case "setLink": {
        const e = pick(roster, op.idx);
        const t = pick(roster, op.targetIdx);
        if (e === undefined || t === undefined || !world.exists(e) || !world.exists(t) || e === t) return;
        if (op.dense) {
          world.set(e, relation(DenseLink, t));
          ensureState(e).denseLink = t;
        } else {
          world.set(e, relation(Link, t));
          ensureState(e).sparseLink = t;
        }
        break;
      }
      case "setCascade": {
        const e = pick(roster, op.idx);
        const t = pick(roster, op.targetIdx);
        if (e === undefined || t === undefined || !world.exists(e) || !world.exists(t) || e === t) return;
        world.set(e, relation(Cascade, t));
        ensureState(e).cascade = t;
        break;
      }
      case "delete": {
        const e = pick(roster, op.idx);
        if (e === undefined || !world.exists(e)) return;
        world.delete(e);
        break;
      }
      case "sync": {
        world.sync();
        reconcileAfterSync();
        break;
      }
    }
  };

  const reconcileAfterSync = (): void => {
    // Drop state for dead entities; strip edges to dead targets.
    for (const e of [...state.keys()]) {
      if (!world.exists(e)) {
        state.delete(e);
        continue;
      }
      const s = state.get(e)!;
      if (s.sparseLink !== undefined && !world.exists(s.sparseLink)) delete s.sparseLink;
      if (s.denseLink !== undefined && !world.exists(s.denseLink)) delete s.denseLink;
      if (s.cascade !== undefined && !world.exists(s.cascade)) {
        // Cascade parent death kills child — if still alive, edge was non-surviving.
        delete s.cascade;
      }
    }

    // Cascade may have killed children we still marked alive in state.
    for (const e of [...state.keys()]) {
      if (!world.exists(e)) state.delete(e);
    }

    // Assert no ghosts: every live known id matches our generation state OR
    // was cascade-killed (already removed). For live entities created this run:
    for (const e of roster) {
      if (!world.exists(e)) continue;
      const s = state.get(e) ?? {};

      // Ghost check: nothing beyond expected
      if (s.pos === undefined) {
        expect(world.has(e, Pos)).toBe(false);
      } else {
        expect(world.get(e, Pos)).toEqual({ x: s.pos });
      }
      expect(world.has(e, Tag)).toBe(s.tag === true);

      if (s.sparseLink === undefined) {
        expect(world.has(e, relation(Link, "*"))).toBe(false);
      } else if (world.exists(s.sparseLink)) {
        expect(world.has(e, relation(Link, s.sparseLink))).toBe(true);
      }

      if (s.denseLink === undefined) {
        expect(world.countRelations(e, DenseLink)).toBe(0);
      } else if (world.exists(s.denseLink)) {
        expect(world.getParent(e, DenseLink)).toBe(s.denseLink);
      }

      if (s.cascade === undefined) {
        expect(world.countRelations(e, Cascade)).toBe(0);
      } else if (world.exists(s.cascade)) {
        expect(world.getParent(e, Cascade)).toBe(s.cascade);
      }
    }

    // Reverse refs never point from dead sources; recycled targets have empty sources
    // for edges that belonged to a previous generation only.
    for (const e of roster) {
      if (!world.exists(e)) {
        // Dead id still in freelist may be queried as target of reverse index —
        // sources list must be empty (or only live sources that still hold the edge).
        for (const rel of [Link, DenseLink, Cascade] as const) {
          for (const src of world.getRelationSources(e, rel)) {
            expect(world.exists(src)).toBe(true);
            expect(world.has(src, relation(rel, e))).toBe(true);
          }
        }
      }
    }
  };

  for (const op of ops) apply(op);
  world.sync();
  reconcileAfterSync();

  // Explicit recycle probe: delete all live, recreate same count, assert empty shells.
  const live = [...new Set(roster.filter((e) => world.exists(e)))];
  for (const e of live) world.delete(e);
  world.sync();
  const recycled: EntityId[] = [];
  for (let i = 0; i < live.length; i++) recycled.push(world.new());
  // LIFO freelist: recycled set equals previous live set (order may differ by free order)
  expect(new Set(recycled)).toEqual(new Set(live));
  for (const e of recycled) {
    expect(world.exists(e)).toBe(true);
    expect(world.has(e, Pos)).toBe(false);
    expect(world.has(e, Tag)).toBe(false);
    expect(world.has(e, relation(Link, "*"))).toBe(false);
    expect(world.countRelations(e, DenseLink)).toBe(0);
    expect(world.countRelations(e, Cascade)).toBe(0);
    expect(world.getRelationSources(e, Link)).toEqual([]);
    expect(world.getRelationSources(e, DenseLink)).toEqual([]);
    expect(world.getRelationSources(e, Cascade)).toEqual([]);
  }
}

describe("PBT: EntityId freelist", () => {
  it("EntityIdManager allocate/free matches LIFO model", () => {
    fc.assert(
      fc.property(allocOpsArb, (ops) => {
        runIdManagerOps(ops);
      }),
      pbtAssertOptions,
    );
  });

  it("World recycled entity ids carry no ghost components or reverse refs", () => {
    fc.assert(
      fc.property(worldOpsArb, (ops) => {
        runWorldRecycleOps(ops);
      }),
      { ...pbtAssertOptions, numRuns: 50 },
    );
  });
});
