import { describe, expect, it } from "bun:test";

import { component, createEntityId, relation } from "../../entity";
import { World } from "../../world/world";

/**
 * Correctness edge cases around deferred command buffering + sync.
 * These pin contracts that are easy to break with ordering / exclusive / reverse-ref changes.
 */
describe("World deferred command edge cases", () => {
  describe("same-frame exclusive relations", () => {
    it("enforces exclusive when two sparse targets are set before one sync", () => {
      const world = new World();
      const ChildOf = component({ exclusive: true, sparse: true });
      const child = world.new();
      const parentA = world.new();
      const parentB = world.new();

      world.set(child, relation(ChildOf, parentA));
      world.set(child, relation(ChildOf, parentB));
      world.sync();

      expect(world.has(child, relation(ChildOf, parentA))).toBe(false);
      expect(world.has(child, relation(ChildOf, parentB))).toBe(true);
      expect(world.getRelationTargets(child, ChildOf).map(([t]) => t)).toEqual([parentB]);
      expect(world.getChildren(parentA, ChildOf)).toEqual([]);
      expect(world.getChildren(parentB, ChildOf)).toEqual([child]);
    });

    it("enforces exclusive when two dense targets are set before one sync", () => {
      const world = new World();
      const ChildOf = component({ exclusive: true });
      const child = world.new();
      const parentA = world.new();
      const parentB = world.new();

      world.set(child, relation(ChildOf, parentA));
      world.set(child, relation(ChildOf, parentB));
      world.sync();

      expect(world.has(child, relation(ChildOf, parentA))).toBe(false);
      expect(world.has(child, relation(ChildOf, parentB))).toBe(true);
      expect(world.countRelations(child, ChildOf)).toBe(1);
    });

    it("enforces exclusive across three same-frame flips (last wins)", () => {
      const world = new World();
      const ChildOf = component({ exclusive: true, sparse: true });
      const child = world.new();
      const p1 = world.new();
      const p2 = world.new();
      const p3 = world.new();

      world.set(child, relation(ChildOf, p1));
      world.set(child, relation(ChildOf, p2));
      world.set(child, relation(ChildOf, p3));
      world.sync();

      expect(world.getParent(child, ChildOf)).toBe(p3);
      expect(world.getChildren(p1, ChildOf)).toEqual([]);
      expect(world.getChildren(p2, ChildOf)).toEqual([]);
      expect(world.getChildren(p3, ChildOf)).toEqual([child]);
    });

    it("exclusive flip after an already-synced relation still replaces in one frame", () => {
      const world = new World();
      const ChildOf = component({ exclusive: true, sparse: true });
      const child = world.new();
      const p1 = world.new();
      const p2 = world.new();
      const p3 = world.new();

      world.set(child, relation(ChildOf, p1));
      world.sync();

      // One frame: reparent twice
      world.set(child, relation(ChildOf, p2));
      world.set(child, relation(ChildOf, p3));
      world.sync();

      expect(world.has(child, relation(ChildOf, p1))).toBe(false);
      expect(world.has(child, relation(ChildOf, p2))).toBe(false);
      expect(world.has(child, relation(ChildOf, p3))).toBe(true);
      expect(world.getChildren(p1, ChildOf)).toEqual([]);
      expect(world.getChildren(p2, ChildOf)).toEqual([]);
      expect(world.getChildren(p3, ChildOf)).toEqual([child]);
    });
  });

  describe("same-frame destroy + relation interactions", () => {
    it("delete(target) then set(relation→target) same frame does not leave reverse refs", () => {
      const world = new World();
      const Link = component({ sparse: true });
      const target = world.new();
      const child = world.new();

      world.delete(target);
      world.set(child, relation(Link, target));
      world.sync();

      expect(world.exists(target)).toBe(false);
      // Relation to a destroyed target must not survive (destroy runs after structural apply
      // and strips reverse-indexed edges).
      expect(world.has(child, relation(Link, target))).toBe(false);
      expect(world.getRelationSources(target, Link)).toEqual([]);

      // Freelist reuses target's id — recycled entity must not inherit orphan reverse edges.
      const recycled = world.new();
      expect(recycled).toBe(target);
      expect(world.getRelationSources(recycled, Link)).toEqual([]);

      world.delete(recycled);
      world.sync();
      expect(world.exists(child)).toBe(true);
      expect(world.has(child, relation(Link, recycled))).toBe(false);
    });

    it("set(relation→target) then delete(target) same frame cleans the edge", () => {
      const world = new World();
      const Link = component({ sparse: true });
      const target = world.new();
      const child = world.new();

      world.set(child, relation(Link, target));
      world.delete(target);
      world.sync();

      expect(world.exists(target)).toBe(false);
      expect(world.has(child, relation(Link, target))).toBe(false);
      expect(world.getRelationSources(target, Link)).toEqual([]);
    });

    it("set + delete same entity in one frame: destroy wins, no leftover components", () => {
      const world = new World();
      const A = component<number>();
      const e = world.new();

      world.set(e, A, 42);
      world.delete(e);
      world.sync();

      expect(world.exists(e)).toBe(false);
      const q = world.createQuery([A]);
      expect(q.getEntities()).toEqual([]);
    });

    it("delete then set same entity in one frame: set is dropped with destroy", () => {
      const world = new World();
      const A = component<number>();
      const e = world.new();

      world.delete(e);
      // Entity still registered pre-sync, so set is accepted into the buffer…
      world.set(e, A, 1);
      world.sync();
      // …but destroy routing drops the whole per-entity batch.
      expect(world.exists(e)).toBe(false);
    });

    it("spawn().with().build() then delete before sync leaves no query residue", () => {
      const world = new World();
      const Pos = component<{ x: number }>();
      const e = world.spawn().with(Pos, { x: 1 }).build();

      expect(world.exists(e)).toBe(true);
      world.delete(e);
      world.sync();

      expect(world.exists(e)).toBe(false);
      expect(world.createQuery([Pos]).getEntities()).toEqual([]);
    });

    it("double delete (same frame and across frames) is idempotent", () => {
      const world = new World();
      const e = world.new();

      world.delete(e);
      world.delete(e);
      expect(() => world.sync()).not.toThrow();
      expect(world.exists(e)).toBe(false);

      expect(() => {
        world.delete(e);
        world.sync();
      }).not.toThrow();

      const fake = createEntityId(99999);
      expect(() => {
        world.delete(fake);
        world.sync();
      }).not.toThrow();
    });
  });

  describe("same-frame set/remove folding", () => {
    it("remove then set on an existing component keeps the component and skips on_remove", () => {
      const world = new World();
      const A = component<number>();
      const e = world.new();
      world.set(e, A, 1);
      world.sync();

      let onSet = 0;
      let onRemove = 0;
      world.hook([A], {
        on_set: () => {
          onSet++;
        },
        on_remove: () => {
          onRemove++;
        },
      });

      world.remove(e, A);
      world.set(e, A, 2);
      world.sync();

      expect(world.get(e, A)).toBe(2);
      expect(onSet).toBe(1);
      expect(onRemove).toBe(0);
    });

    it("set then remove same new component cancels to absent", () => {
      const world = new World();
      const A = component<number>();
      const e = world.new();

      world.set(e, A, 1);
      world.remove(e, A);
      world.sync();

      expect(world.has(e, A)).toBe(false);
      expect(world.getOptional(e, A)).toBeUndefined();
    });
  });

  describe("cascade + pending commands", () => {
    it("pending set on a cascade-deleted child does not resurrect it", () => {
      const world = new World();
      const ChildOf = component({ cascadeDelete: true, sparse: true });
      const A = component<number>();
      const parent = world.new();
      const child = world.new();

      world.set(child, relation(ChildOf, parent));
      world.sync();

      world.delete(parent);
      world.set(child, A, 99);
      world.sync();

      expect(world.exists(parent)).toBe(false);
      expect(world.exists(child)).toBe(false);
    });

    it("mixed cascade and non-cascade edges: only cascade sources die", () => {
      const world = new World();
      const Owns = component({ cascadeDelete: true, sparse: true });
      const Watches = component({ sparse: true });
      const target = world.new();
      const owner = world.new();
      const watcher = world.new();

      world.set(owner, relation(Owns, target));
      world.set(watcher, relation(Watches, target));
      world.sync();

      world.delete(target);
      world.sync();

      expect(world.exists(target)).toBe(false);
      expect(world.exists(owner)).toBe(false);
      expect(world.exists(watcher)).toBe(true);
      expect(world.has(watcher, relation(Watches, target))).toBe(false);
    });

    it("diamond cascade graph deletes every descendant once", () => {
      const world = new World();
      // Non-exclusive so two parents can both point at the shared child edge pattern:
      //   root → a, root → b, a → leaf, b → leaf  (via cascade ChildOf pointing upward)
      const ChildOf = component({ cascadeDelete: true, sparse: true });
      const root = world.new();
      const a = world.new();
      const b = world.new();
      const leaf = world.new();

      world.set(a, relation(ChildOf, root));
      world.set(b, relation(ChildOf, root));
      world.set(leaf, relation(ChildOf, a));
      // leaf cannot have two ChildOf if exclusive; use a second cascade type for the other edge
      const AlsoChildOf = component({ cascadeDelete: true, sparse: true });
      world.set(leaf, relation(AlsoChildOf, b));
      world.sync();

      world.delete(root);
      world.sync();

      expect(world.exists(root)).toBe(false);
      expect(world.exists(a)).toBe(false);
      expect(world.exists(b)).toBe(false);
      expect(world.exists(leaf)).toBe(false);
    });
  });

  describe("query visibility vs deferred buffer", () => {
    it("cached queries reflect membership only after sync", () => {
      const world = new World();
      const A = component<number>();
      const e = world.new();
      const q = world.createQuery([A]);

      world.set(e, A, 1);
      expect(q.getEntities()).toEqual([]);

      world.sync();
      expect(q.getEntities()).toEqual([e]);

      world.delete(e);
      expect(q.getEntities()).toEqual([e]);

      world.sync();
      expect(q.getEntities()).toEqual([]);
    });

    it("nested sync() inside a hook still drains follow-up commands", () => {
      const world = new World();
      const A = component<number>();
      const B = component<number>();
      const e = world.new();
      const other = world.new();

      world.hook([A], {
        on_set: () => {
          world.sync(); // re-entrant: must not swallow subsequent buffered work
          world.set(other, B, 1);
        },
      });

      world.set(e, A, 1);
      world.sync();

      expect(world.has(e, A)).toBe(true);
      expect(world.has(other, B)).toBe(true);
    });
  });

  describe("entity id freelist reuse safety", () => {
    it("recycled entity id does not inherit previous components or relations", () => {
      const world = new World();
      const Pos = component<{ x: number }>();
      const Link = component({ sparse: true });
      const target = world.new();
      const e = world.new();

      world.set(e, Pos, { x: 1 });
      world.set(e, relation(Link, target));
      world.sync();

      world.delete(e);
      world.sync();

      const reused = world.new();
      expect(reused).toBe(e);
      expect(world.has(reused, Pos)).toBe(false);
      expect(world.has(reused, relation(Link, target))).toBe(false);
      expect(world.getRelationSources(target, Link)).toEqual([]);
    });
  });
});

describe("World wildcard has/get consistency", () => {
  it("has() agrees with getOptional() for dense wildcard relations", () => {
    const world = new World();
    const Rel = component<number>();
    const e = world.new();
    const t1 = world.new();
    const t2 = world.new();
    const wild = relation(Rel, "*");

    expect(world.has(e, wild)).toBe(false);
    expect(world.getOptional(e, wild)).toBeUndefined();

    world.set(e, relation(Rel, t1), 1);
    world.sync();

    expect(world.has(e, wild)).toBe(true);
    expect(world.getOptional(e, wild)?.value).toEqual([[t1, 1]]);
    expect(world.get(e, wild)).toEqual([[t1, 1]]);

    world.set(e, relation(Rel, t2), 2);
    world.sync();
    expect(world.has(e, wild)).toBe(true);
    expect(world.get(e, wild)).toHaveLength(2);

    world.remove(e, relation(Rel, t1));
    world.remove(e, relation(Rel, t2));
    world.sync();
    expect(world.has(e, wild)).toBe(false);
    expect(world.getOptional(e, wild)).toBeUndefined();
  });

  it("has() agrees with getOptional() for sparse wildcard relations", () => {
    const world = new World();
    const Rel = component<number>({ sparse: true });
    const e = world.new();
    const t = world.new();
    const wild = relation(Rel, "*");

    world.set(e, relation(Rel, t), 7);
    world.sync();

    expect(world.has(e, wild)).toBe(true);
    expect(world.getOptional(e, wild)?.value).toEqual([[t, 7]]);

    world.remove(e, relation(Rel, t));
    world.sync();
    expect(world.has(e, wild)).toBe(false);
  });

  it("EntityView.has matches World.has for dense wildcards", () => {
    const world = new World();
    const Tag = component<void>();
    const Rel = component<number>();
    const e = world.new();
    const t = world.new();
    world.set(e, Tag);
    world.set(e, relation(Rel, t), 3);
    world.sync();

    const wild = relation(Rel, "*");
    const q = world.createQuery([Tag]);
    let viewHas: boolean | undefined;
    q.forEachView((_entity, view) => {
      viewHas = view.has(wild);
      expect(view.get(wild)).toEqual([[t, 3]]);
    });
    expect(viewHas).toBe(true);
    expect(world.has(e, wild)).toBe(true);
  });
});

describe("World serialize/restore edge cases", () => {
  it("round-trips non-skipSerialize sparse relations and reverse refs", () => {
    const world = new World();
    const Link = component<{ w: number }>({ sparse: true });
    const a = world.new();
    const b = world.new();
    world.set(a, relation(Link, b), { w: 7 });
    world.sync();

    const restored = new World(world.serialize());
    expect(restored.has(a, relation(Link, b))).toBe(true);
    expect(restored.get(a, relation(Link, b))).toEqual({ w: 7 });
    expect(restored.getRelationSources(b, Link)).toEqual([a]);
    expect(restored.get(a, relation(Link, "*"))).toEqual([[b, { w: 7 }]]);
  });

  it("restored cascadeDelete relations still cascade", () => {
    const world = new World();
    const ChildOf = component({ cascadeDelete: true, sparse: true });
    const parent = world.new();
    const child = world.new();
    world.set(child, relation(ChildOf, parent));
    world.sync();

    const restored = new World(world.serialize());
    restored.delete(parent);
    restored.sync();

    expect(restored.exists(parent)).toBe(false);
    expect(restored.exists(child)).toBe(false);
  });

  it("freelist state survives serialize so recycle order stays stable", () => {
    const world = new World();
    const a = world.new();
    const b = world.new();
    world.delete(a);
    world.sync();

    const restored = new World(world.serialize());
    const recycled = restored.new();
    expect(recycled).toBe(a);
    expect(restored.exists(b)).toBe(true);
    expect(restored.exists(a)).toBe(true); // recycled id is live again
  });
});

describe("World optional component transitions", () => {
  it("query optional presence flips correctly across syncs", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const e = world.new();
    world.set(e, A, 1);
    world.sync();

    const q = world.createQuery([A]);
    const seen: Array<{ b: { value: string } | undefined }> = [];

    const collect = () => {
      seen.length = 0;
      q.forEach([A, { optional: B }], (_entity, _a, b) => {
        seen.push({ b });
      });
    };

    collect();
    expect(seen).toEqual([{ b: undefined }]);

    world.set(e, B, "hi");
    world.sync();
    collect();
    expect(seen).toEqual([{ b: { value: "hi" } }]);

    world.remove(e, B);
    world.sync();
    collect();
    expect(seen).toEqual([{ b: undefined }]);
  });
});
