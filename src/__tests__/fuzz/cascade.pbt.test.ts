import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";
import { pbtAssertOptions } from "./config";

/**
 * Cascade delete graph semantics:
 * - ChildOf with cascadeDelete: deleting target BFS-kills all sources that still
 *   hold a cascade edge to a dying entity.
 * - Non-cascade watches: source survives, edge is stripped.
 * Oracle is a pure BFS over the edge lists after the last successful sync setup.
 */

const ChildOf = component({ exclusive: true, cascadeDelete: true, sparse: true });
const Watches = component({ sparse: true }); // non-cascade, multi-target ok
const Marker = component<number>();
const AlsoChildOf = component({ cascadeDelete: true, sparse: true });

type Watch = { watcher: number; target: number };

const graphArb = fc.integer({ min: 2, max: 12 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    // Forest-ish exclusive parents: each node picks a parent index < self or none (-1)
    // plus some random exclusive rewires, then a delete set.
    parents: fc.array(fc.integer({ min: -1, max: n - 1 }), { minLength: n, maxLength: n }),
    rewires: fc.array(fc.tuple(fc.nat({ max: n - 1 }), fc.nat({ max: n - 1 })), {
      minLength: 0,
      maxLength: 15,
    }),
    watches: fc.array(fc.tuple(fc.nat({ max: n - 1 }), fc.nat({ max: n - 1 })), {
      minLength: 0,
      maxLength: 15,
    }),
    markers: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: n, maxLength: n }),
    deleteSet: fc.uniqueArray(fc.nat({ max: n - 1 }), { minLength: 1, maxLength: Math.min(6, n) }),
  }),
);

/**
 * Expected survivors after deleting `roots` given exclusive cascade edges child→parent
 * and non-cascade watches watcher→target.
 */
function expectedAlive(
  n: number,
  cascadeParent: (number | undefined)[],
  watches: Watch[],
  roots: number[],
): { alive: boolean[]; strippedWatches: Set<string> } {
  const alive = Array.from({ length: n }, () => true);

  // Reverse index: parent -> children with cascade edge
  const childrenOf = Array.from({ length: n }, () => [] as number[]);
  for (let c = 0; c < n; c++) {
    const p = cascadeParent[c];
    if (p !== undefined && p !== c) childrenOf[p]!.push(c);
  }

  const queue = [...roots];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    alive[cur] = false;
    for (const child of childrenOf[cur]!) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  const strippedWatches = new Set<string>();
  for (const w of watches) {
    if (!alive[w.target]! || !alive[w.watcher]!) {
      strippedWatches.add(`${w.watcher}->${w.target}`);
    }
  }

  return { alive, strippedWatches };
}

function buildAndAssert(input: {
  n: number;
  parents: number[];
  rewires: [number, number][];
  watches: [number, number][];
  markers: number[];
  deleteSet: number[];
}): void {
  const { n, parents, rewires, watches: watchPairs, markers, deleteSet } = input;
  const world = new World();
  const entities: EntityId[] = [];
  for (let i = 0; i < n; i++) entities.push(world.new());

  // Exclusive cascade parents from initial parents array (skip self / OOB / -1).
  const cascadeParent: (number | undefined)[] = Array.from({ length: n }, () => undefined);
  for (let c = 0; c < n; c++) {
    const p = parents[c]!;
    if (p < 0 || p >= n || p === c) continue;
    world.set(entities[c]!, relation(ChildOf, entities[p]!));
    cascadeParent[c] = p;
  }

  // Rewires: exclusive last-wins
  for (const [cRaw, pRaw] of rewires) {
    const c = cRaw % n;
    const p = pRaw % n;
    if (c === p) continue;
    world.set(entities[c]!, relation(ChildOf, entities[p]!));
    cascadeParent[c] = p;
  }

  const watches: Watch[] = [];
  for (const [wRaw, tRaw] of watchPairs) {
    const w = wRaw % n;
    const t = tRaw % n;
    if (w === t) continue;
    world.set(entities[w]!, relation(Watches, entities[t]!));
    watches.push({ watcher: w, target: t });
  }

  for (let i = 0; i < n; i++) {
    world.set(entities[i]!, Marker, markers[i]!);
  }

  world.sync();

  // Pre-delete invariants
  for (let i = 0; i < n; i++) {
    const e = entities[i]!;
    expect(world.exists(e)).toBe(true);
    expect(world.get(e, Marker)).toBe(markers[i]!);
    const p = cascadeParent[i];
    if (p === undefined) {
      expect(world.countRelations(e, ChildOf)).toBe(0);
    } else {
      expect(world.getParent(e, ChildOf)).toBe(entities[p]!);
    }
  }

  const roots = deleteSet.map((i) => i % n);
  const uniqueRoots = [...new Set(roots)];
  for (const r of uniqueRoots) {
    world.delete(entities[r]!);
  }
  world.sync();

  const { alive, strippedWatches } = expectedAlive(n, cascadeParent, watches, uniqueRoots);

  for (let i = 0; i < n; i++) {
    const e = entities[i]!;
    expect(world.exists(e)).toBe(alive[i]!);
    if (!alive[i]!) continue;

    // Survivors keep marker
    expect(world.get(e, Marker)).toBe(markers[i]!);

    // Cascade edges only to live parents; if our parent died we must have died too
    const p = cascadeParent[i];
    if (p !== undefined) {
      if (alive[p]!) {
        expect(world.getParent(e, ChildOf)).toBe(entities[p]!);
        expect(world.getChildren(entities[p]!, ChildOf)).toContain(e);
      } else {
        // Should have been cascade-killed — already checked exists
        expect(alive[i]).toBe(false);
      }
    } else {
      expect(world.countRelations(e, ChildOf)).toBe(0);
    }
  }

  // Non-cascade watches: live watcher must not retain edge to dead target;
  // live-live edges remain.
  for (const w of watches) {
    const key = `${w.watcher}->${w.target}`;
    const watcher = entities[w.watcher]!;
    const target = entities[w.target]!;
    if (!alive[w.watcher]!) continue;
    if (strippedWatches.has(key) || !alive[w.target]!) {
      expect(world.has(watcher, relation(Watches, target))).toBe(false);
    } else {
      expect(world.has(watcher, relation(Watches, target))).toBe(true);
      expect(world.getRelationSources(target, Watches)).toContain(watcher);
    }
  }

  // Global: no live entity holds ChildOf → dead target
  for (let i = 0; i < n; i++) {
    if (!alive[i]!) continue;
    for (const [t] of world.getRelationTargets(entities[i]!, ChildOf)) {
      expect(world.exists(t)).toBe(true);
    }
  }

  // Recycled ids from cascade victims are clean shells
  const deadIds = entities.filter((_, i) => !alive[i]!);
  const recycled: EntityId[] = [];
  for (let i = 0; i < deadIds.length; i++) recycled.push(world.new());
  expect(new Set(recycled)).toEqual(new Set(deadIds));
  for (const e of recycled) {
    expect(world.has(e, Marker)).toBe(false);
    expect(world.countRelations(e, ChildOf)).toBe(0);
    expect(world.has(e, relation(Watches, "*"))).toBe(false);
    expect(world.getRelationSources(e, ChildOf)).toEqual([]);
    expect(world.getRelationSources(e, Watches)).toEqual([]);
  }
}

/** Multi-hop chain: 0←1←2←…←k-1 (child points to parent), delete root 0. */
const chainArb = fc.integer({ min: 2, max: 15 });

describe("PBT: cascade delete graphs", () => {
  it("random exclusive cascade forest + watches matches BFS oracle", () => {
    fc.assert(
      fc.property(graphArb, (g) => {
        buildAndAssert(g);
      }),
      { ...pbtAssertOptions, numRuns: 50 },
    );
  });

  it("linear cascade chain: delete root kills entire chain", () => {
    fc.assert(
      fc.property(chainArb, (k) => {
        const world = new World();
        const nodes: EntityId[] = [];
        for (let i = 0; i < k; i++) nodes.push(world.new());
        // child i points to i-1
        for (let i = 1; i < k; i++) {
          world.set(nodes[i]!, relation(ChildOf, nodes[i - 1]!));
        }
        world.sync();

        world.delete(nodes[0]!);
        world.sync();

        for (const e of nodes) {
          expect(world.exists(e)).toBe(false);
        }
      }),
      pbtAssertOptions,
    );
  });

  it("delete leaf does not kill ancestors", () => {
    fc.assert(
      fc.property(chainArb, (k) => {
        const world = new World();
        const nodes: EntityId[] = [];
        for (let i = 0; i < k; i++) nodes.push(world.new());
        for (let i = 1; i < k; i++) {
          world.set(nodes[i]!, relation(ChildOf, nodes[i - 1]!));
        }
        world.sync();

        world.delete(nodes[k - 1]!);
        world.sync();

        expect(world.exists(nodes[k - 1]!)).toBe(false);
        for (let i = 0; i < k - 1; i++) {
          expect(world.exists(nodes[i]!)).toBe(true);
        }
      }),
      pbtAssertOptions,
    );
  });

  it("diamond via two cascade relation types deletes all descendants", () => {
    // root → a, root → b, leaf → a (ChildOf), leaf → b (AlsoChildOf)
    const world = new World();
    const root = world.new();
    const a = world.new();
    const b = world.new();
    const leaf = world.new();
    world.set(a, relation(ChildOf, root));
    world.set(b, relation(ChildOf, root));
    world.set(leaf, relation(ChildOf, a));
    world.set(leaf, relation(AlsoChildOf, b));
    world.sync();

    world.delete(root);
    world.sync();

    for (const e of [root, a, b, leaf]) {
      expect(world.exists(e)).toBe(false);
    }
  });
});
