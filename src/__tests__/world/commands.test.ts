import { describe, expect, it } from "bun:test";

import { Archetype } from "../../archetype/archetype";
import { SparseStoreImpl } from "../../archetype/store";
import { ComponentChangeset } from "../../commands/changeset";
import { component, createEntityId, relation, type ComponentId, type EntityId } from "../../entity";
import {
  applyChangeset,
  areComponentTypesEqual,
  filterRegularComponentTypes,
  maybeRemoveWildcardMarker,
  type CommandProcessorContext,
} from "../../world/commands";
import { World } from "../../world/world";

function createSparseStore() {
  return new SparseStoreImpl();
}

function makeArchetype(componentTypes: EntityId<any>[]): Archetype {
  return new Archetype(componentTypes, createSparseStore());
}

function makeCtx(): CommandProcessorContext {
  const store = createSparseStore();
  return {
    sparseStore: store,
    ensureArchetype: (types) => new Archetype(Array.from(types), store),
  };
}

describe("world/commands internal coverage", () => {
  const A = component<number>();
  const B = component<string>();
  const Tag = component({ sparse: true });
  const Data = component<{ v: number }>({ sparse: true });
  const ExclusiveTag = component({ sparse: true, exclusive: true });

  describe("areComponentTypesEqual", () => {
    it("returns true for equal arrays (same order)", () => {
      expect(areComponentTypesEqual([A, B], [A, B])).toBe(true);
    });

    it("returns true for equal arrays after normalization (different order)", () => {
      expect(areComponentTypesEqual([B, A], [A, B])).toBe(true);
    });

    it("returns false for different lengths", () => {
      expect(areComponentTypesEqual([A], [A, B])).toBe(false);
    });

    it("returns false for different content after normalization", () => {
      expect(areComponentTypesEqual([A, B], [A, Tag])).toBe(false);
    });
  });

  describe("filterRegularComponentTypes", () => {
    it("keeps wildcard markers for dontFragment and drops specific dontFragment relations", () => {
      const wild = relation(Tag, "*");
      const specific = relation(Tag, createEntityId(9999) as EntityId);
      const result = filterRegularComponentTypes([A, specific, wild, B]);
      // specific dontFragment relation should be filtered out; wildcard marker kept
      expect(result).toContain(wild);
      expect(result).toContain(A);
      expect(result).toContain(B);
      expect(result).not.toContain(specific);
    });
  });

  describe("removeMatchingRelations + maybeRemoveWildcardMarker (marker retention)", () => {
    it("keeps wildcard marker when removing one of multiple non-exclusive dontFragment relations (archetype path)", () => {
      const store = createSparseStore();
      const p1 = createEntityId(2001) as EntityId;
      const p2 = createEntityId(2002) as EntityId;
      const r1 = relation(Tag, p1);
      const r2 = relation(Tag, p2);
      const wild = relation(Tag, "*");

      // Archetype declares the wildcard marker (as required for dontFragment)
      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(5001) as EntityId;

      // Put the entity in the archetype with two concrete relations stored in dontFragment store
      arch.addEntity(entity, new Map([[A, 1]]));
      store.setValue(entity, r1, undefined);
      store.setValue(entity, r2, undefined);

      const changeset = new ComponentChangeset();
      // Remove only one target
      changeset.delete(r1);

      // Call the function under test (simulates what processDeleteCommand does for non-wildcard delete)
      maybeRemoveWildcardMarker(entity, arch, r1, Tag as unknown as ComponentId<any>, changeset);

      // Marker must NOT have been scheduled for removal
      expect(changeset.removes.has(wild)).toBe(false);
      // We only mutated changeset; the store still contains the other relation entry
      // (presence is observable via getAllForEntity because value may legitimately be undefined for tags)
      const remaining = store.getAllForEntity(entity).some(([t]) => t === r2);
      expect(remaining).toBe(true);
    });

    it("keeps wildcard marker when other relation exists only in dontFragmentData for the entity", () => {
      const store = createSparseStore();
      const p1 = createEntityId(2001) as EntityId;
      const p2 = createEntityId(2002) as EntityId;
      const r1 = relation(Tag, p1);
      const r2 = relation(Tag, p2);
      const wild = relation(Tag, "*");

      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(5002) as EntityId;

      arch.addEntity(entity, new Map([[A, 1]]));
      // Only store relations in dontFragment (no regular archetype components for them)
      store.setValue(entity, r1, undefined);
      store.setValue(entity, r2, undefined);

      const changeset = new ComponentChangeset();
      changeset.delete(r1);

      maybeRemoveWildcardMarker(entity, arch, r1, Tag as unknown as ComponentId<any>, changeset);

      expect(changeset.removes.has(wild)).toBe(false);
    });

    it("keeps wildcard marker on exclusive dontFragment flip when remove+add are in same changeset (batch)", () => {
      const store = createSparseStore();
      const p1 = createEntityId(3001) as EntityId;
      const p2 = createEntityId(3002) as EntityId;
      const r1 = relation(ExclusiveTag, p1);
      const r2 = relation(ExclusiveTag, p2);
      const wild = relation(ExclusiveTag, "*");

      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(5003) as EntityId;

      arch.addEntity(entity, new Map([[A, 1]]));
      store.setValue(entity, r1, { x: 1 }); // some value

      const changeset = new ComponentChangeset();
      // Simulate exclusive flip: remove old target, add new target in one batch
      changeset.delete(r1);
      changeset.set(r2, undefined); // ExclusiveTag is a void/tag dontFragment component

      maybeRemoveWildcardMarker(entity, arch, r1, ExclusiveTag as unknown as ComponentId<any>, changeset);

      // Because a replacement add is present, marker must be kept
      expect(changeset.removes.has(wild)).toBe(false);
    });
  });

  describe("pruneMissingRemovals (via applyChangeset)", () => {
    it("prunes remove commands for components the entity does not actually have", () => {
      const ctx = makeCtx();
      const entity = createEntityId(6001) as EntityId;

      // Archetype with only A
      const arch = makeArchetype([A]);
      arch.addEntity(entity, new Map([[A, 42]]));

      const changeset = new ComponentChangeset();
      // Spurious removes that do not exist on the entity
      changeset.delete(B);
      changeset.delete(relation(Tag, createEntityId(7777) as EntityId));

      const entityToArch = new Map([[entity, arch]]);
      const removed: Map<EntityId<any>, any> | null = new Map();

      const resultArch = applyChangeset(ctx, entity, arch, changeset, entityToArch, removed);

      // No structural change should have occurred (pruned), entity stays in same archetype
      expect(resultArch).toBe(arch);
      expect(entityToArch.get(entity)).toBe(arch);
      // The spurious removes should have been pruned (no error, no move)
      expect(changeset.removes.size).toBe(0);
    });
  });

  describe("applyDontFragmentChanges recording paths (with hooks)", () => {
    it("records removal of dontFragment relation even when stored value is undefined (tag/void case)", () => {
      const store = createSparseStore();
      const p = createEntityId(4001) as EntityId;
      const r = relation(Tag, p); // Tag is dontFragment void-style
      const wild = relation(Tag, "*");

      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(7001) as EntityId;
      arch.addEntity(entity, new Map([[A, 1]]));
      store.setValue(entity, r, undefined); // explicitly undefined payload

      const changeset = new ComponentChangeset();
      changeset.delete(r);

      // removedComponents non-null triggers the hook-recording path
      const removedComponents = new Map<EntityId<any>, any>();

      const ctx: CommandProcessorContext = {
        sparseStore: store,
        ensureArchetype: (t) => new Archetype(Array.from(t), store),
      };

      // No regular structural change (only dontFragment relation change)
      applyChangeset(ctx, entity, arch, changeset, new Map(), removedComponents);

      // The key: we should have recorded something for the removed dontFragment relation
      // even though its value was undefined. This exercises the getAllForEntity fallback.
      expect(removedComponents.has(r)).toBe(true);
    });

    it("records and applies normal dontFragment add/remove with data payloads", () => {
      const store = createSparseStore();
      const p = createEntityId(4002) as EntityId;
      const r = relation(Data, p);
      const wild = relation(Data, "*");

      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(7002) as EntityId;
      arch.addEntity(entity, new Map([[A, 1]]));

      const changeset = new ComponentChangeset();
      changeset.set(r, { v: 99 });

      const ctx: CommandProcessorContext = {
        sparseStore: store,
        ensureArchetype: (t) => new Archetype(Array.from(t), store),
      };

      applyChangeset(ctx, entity, arch, changeset, new Map(), null);

      expect(store.getValue(entity, r)).toEqual({ v: 99 });
    });
  });

  describe("applyChangeset archetype move vs in-place dontFragment update", () => {
    it("moves archetype when regular component is added/removed alongside dontFragment changes", () => {
      const store = createSparseStore();
      const p = createEntityId(5005) as EntityId;
      const r = relation(Data, p);
      const wild = relation(Data, "*");

      const arch = new Archetype([A, wild], store);
      const entity = createEntityId(8001) as EntityId;
      arch.addEntity(entity, new Map([[A, 1]]));
      store.setValue(entity, r, { v: 1 });

      const changeset = new ComponentChangeset();
      changeset.delete(A); // regular component removal → structural change
      changeset.delete(r); // dontFragment

      const ctx: CommandProcessorContext = {
        sparseStore: store,
        ensureArchetype: (t) => new Archetype(Array.from(t), store),
      };
      const entityToArch = new Map([[entity, arch]]);
      const removed = new Map();

      const newArch = applyChangeset(ctx, entity, arch, changeset, entityToArch, removed);

      expect(newArch).not.toBe(arch);
      expect(entityToArch.get(entity)).toBe(newArch);
      expect(removed.has(r)).toBe(true); // recorded because removedComponents was provided
    });
  });

  // These tests go through the public World API + full command processing pipeline
  // (processCommands → processDeleteCommand → maybeRemoveWildcardMarker, etc.)
  // to ensure branch coverage is attributed correctly for the early-return paths.
  describe("public API paths for remaining branch coverage (processDeleteCommand etc.)", () => {
    it("non-exclusive dontFragment: removing one target keeps wildcard marker (via World commands)", () => {
      const world = new World();
      const ParentTag = component({ sparse: true }); // non-exclusive
      const p1 = world.new();
      const p2 = world.new();
      const child = world.new();

      const r1 = relation(ParentTag, p1);
      const r2 = relation(ParentTag, p2);
      const wild = relation(ParentTag, "*");

      world.set(child, r1, undefined);
      world.set(child, r2, undefined);
      world.sync();

      // At this point child should have the wildcard marker in its (regular) component types
      // Remove only one concrete relation
      world.remove(child, r1);
      world.sync();

      // Marker must still exist (we can observe via wildcard query or has on the marker)
      expect(world.has(child, wild)).toBe(true);
      // The other relation survives
      expect(world.has(child, r2)).toBe(true);
      // The removed one is gone
      expect(world.has(child, r1)).toBe(false);
    });

    it("exclusive dontFragment replacement via set (normal path) retains marker and cleans old target", () => {
      const world = new World();
      const ChildOf = component({ sparse: true, exclusive: true });
      const parentA = world.new();
      const parentB = world.new();
      const child = world.new();

      const rA = relation(ChildOf, parentA);
      const rB = relation(ChildOf, parentB);
      const wild = relation(ChildOf, "*");

      world.set(child, rA, undefined);
      world.sync();

      // Normal exclusive flip via set — handleExclusiveRelation removes the old target
      // using removeMatchingRelations (direct changeset delete, marker kept by other logic)
      world.set(child, rB, undefined);
      world.sync();

      expect(world.has(child, wild)).toBe(true);
      expect(world.has(child, rB)).toBe(true);
      expect(world.has(child, rA)).toBe(false);
    });

    it("spurious remove of non-present component is a no-op (pruneMissingRemovals via World)", () => {
      const world = new World();
      const Pos = component<{ x: number }>();
      const e = world.new();
      world.set(e, Pos, { x: 10 });
      world.sync();

      // Remove something that was never present
      world.remove(e, B);
      // Should not throw and not affect existing data
      world.sync();

      expect(world.has(e, Pos)).toBe(true);
      expect(world.get(e, Pos)).toEqual({ x: 10 });
    });
  });
});
