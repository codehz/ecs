import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../../entity";
import type { SyncDebugStats } from "../../../types";
import { World } from "../../../world/world";

describe("Sparse Relations", () => {
  it("should prevent archetype fragmentation for sparse relations", () => {
    const world = new World();

    // Create component types
    type Position = { x: number; y: number };
    const PositionId = component<Position>();
    const VelocityId = component();

    // Create ChildOf with sparse option
    const ChildOf = component({ sparse: true });

    const collected: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => collected.push(s));

    // Create parent entities
    const parent1 = world.new();
    const parent2 = world.new();
    const parent3 = world.new();

    // Create child entities with different parents
    const child1 = world.new();
    world.set(child1, PositionId, { x: 1, y: 1 });
    world.set(child1, VelocityId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId, { x: 2, y: 2 });
    world.set(child2, VelocityId);
    world.set(child2, relation(ChildOf, parent2));

    const child3 = world.new();
    world.set(child3, PositionId, { x: 3, y: 3 });
    world.set(child3, VelocityId);
    world.set(child3, relation(ChildOf, parent3));

    world.sync();

    // Use debug stats to confirm low archetype count (no fragmentation)
    const lastStats = collected[collected.length - 1]!;
    // With sparse, 3 children + different parents should not explode archetype count
    expect(lastStats.archetypes.total).toBeLessThanOrEqual(4);

    // Verify we can still access the relations
    expect(world.has(child1, relation(ChildOf, parent1))).toBe(true);
    expect(world.has(child2, relation(ChildOf, parent2))).toBe(true);
    expect(world.has(child3, relation(ChildOf, parent3))).toBe(true);

    // Verify queries still work
    const entities = world.query([PositionId, VelocityId]);
    expect(entities.length).toBe(3);
  });

  it("should handle sparse relations with wildcard queries", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ sparse: true });

    const parent1 = world.new();
    const parent2 = world.new();

    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, relation(ChildOf, parent2));

    world.sync();

    // Wildcard query should work with sparse relations
    const wildcardChildOf = relation(ChildOf, "*");
    const child1Relations = world.get(child1, wildcardChildOf);
    const child2Relations = world.get(child2, wildcardChildOf);

    expect(child1Relations.length).toBe(1);
    expect(child1Relations[0]![0]).toBe(parent1);

    expect(child2Relations.length).toBe(1);
    expect(child2Relations[0]![0]).toBe(parent2);
  });

  it("should allow updating sparse relations", () => {
    const world = new World();

    const ChildOf = component({ sparse: true, exclusive: true });
    const PositionId = component();

    const parent1 = world.new();
    const parent2 = world.new();
    const child = world.new();

    world.set(child, PositionId);
    world.set(child, relation(ChildOf, parent1));
    world.sync();

    expect(world.has(child, relation(ChildOf, parent1))).toBe(true);

    // Change parent (exclusive should replace)
    world.set(child, relation(ChildOf, parent2));
    world.sync();

    expect(world.has(child, relation(ChildOf, parent1))).toBe(false);
    expect(world.has(child, relation(ChildOf, parent2))).toBe(true);
  });

  it("should handle removing sparse relations", () => {
    const world = new World();

    const ChildOf = component({ sparse: true });
    const PositionId = component();

    const parent = world.new();
    const child = world.new();

    world.set(child, PositionId);
    world.set(child, relation(ChildOf, parent));
    world.sync();

    expect(world.has(child, relation(ChildOf, parent))).toBe(true);

    // Remove the relation
    world.remove(child, relation(ChildOf, parent));
    world.sync();

    expect(world.has(child, relation(ChildOf, parent))).toBe(false);
    expect(world.has(child, PositionId)).toBe(true);
  });

  it("should handle queries with sparse relations", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ sparse: true });

    const collected: SyncDebugStats[] = [];
    using _collector = world.createDebugStatsCollector((s) => collected.push(s));

    const parent1 = world.new();
    const parent2 = world.new();

    // Create entities with sparse relations
    for (let i = 0; i < 10; i++) {
      const entity = world.new();
      world.set(entity, PositionId);
      world.set(entity, VelocityId);
      world.set(entity, relation(ChildOf, i % 2 === 0 ? parent1 : parent2));
    }

    world.sync();

    // Query should find all entities despite different parent relations
    const query = world.createQuery([PositionId, VelocityId]);
    const entities = query.getEntities();
    expect(entities.length).toBe(10);

    // Use debug collector to verify we stayed in a single archetype despite 10 different parents
    const stats = collected[collected.length - 1]!;
    expect(stats.archetypes.total).toBeLessThanOrEqual(3);
  });

  it("should compare fragmentation: with and without sparse", () => {
    // Test WITHOUT sparse (causes fragmentation)
    const world1 = new World();
    const PositionId1 = component();
    const ChildOf1 = component(); // No sparse

    const stats1: SyncDebugStats[] = [];
    using _collector1 = world1.createDebugStatsCollector((s) => stats1.push(s));

    for (let i = 0; i < 5; i++) {
      const parent = world1.new();
      const child = world1.new();
      world1.set(child, PositionId1);
      world1.set(child, relation(ChildOf1, parent));
    }
    world1.sync();

    // Test WITH sparse (prevents fragmentation)
    const world2 = new World();
    const PositionId2 = component();
    const ChildOf2 = component({ sparse: true }); // With sparse

    const stats2: SyncDebugStats[] = [];
    using _collector2 = world2.createDebugStatsCollector((s) => stats2.push(s));

    for (let i = 0; i < 5; i++) {
      const parent = world2.new();
      const child = world2.new();
      world2.set(child, PositionId2);
      world2.set(child, relation(ChildOf2, parent));
    }
    world2.sync();

    const last1 = stats1[stats1.length - 1]!;
    const last2 = stats2[stats2.length - 1]!;

    // Without sparse: we expect significantly more archetypes created due to fragmentation
    // (one per unique parent relation target)
    expect(last1.archetypes.total).toBeGreaterThan(last2.archetypes.total);

    // With sparse: far fewer archetypes for the same number of entities
    expect(last2.archetypes.total).toBeLessThanOrEqual(3); // entities + relations archetype(s)
  });

  it("should query entities with wildcard relation on sparse component using createQuery", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ sparse: true });

    const parent1 = world.new();
    const parent2 = world.new();

    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, relation(ChildOf, parent2));

    world.sync();

    // Try to query entities with wildcard ChildOf relation
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf]);
    const entities = query.getEntities();

    // This should find both child1 and child2
    expect(entities.length).toBe(2);
    expect(entities).toContain(child1);
    expect(entities).toContain(child2);
  });

  it("should query entities with wildcard relation + other components on sparse", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ sparse: true });

    const parent1 = world.new();
    const parent2 = world.new();

    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, VelocityId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, VelocityId);
    world.set(child2, relation(ChildOf, parent2));

    // Entity without ChildOf relation
    const child3 = world.new();
    world.set(child3, PositionId);
    world.set(child3, VelocityId);

    world.sync();

    // Query for entities with wildcard ChildOf relation AND Position
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);
    const entities = query.getEntities();

    // Should find child1 and child2, but not child3 (no ChildOf relation)
    expect(entities.length).toBe(2);
    expect(entities).toContain(child1);
    expect(entities).toContain(child2);
    expect(entities).not.toContain(child3);
  });

  it("should correctly cleanup sparse relations when target entity is destroyed", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ sparse: true });

    const parent1 = world.new();
    const parent2 = world.new();

    // Create children with sparse relations
    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, VelocityId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, VelocityId);
    world.set(child2, relation(ChildOf, parent2));

    const child3 = world.new();
    world.set(child3, PositionId);
    world.set(child3, VelocityId);
    world.set(child3, relation(ChildOf, parent1)); // Same parent as child1

    world.sync();

    // All children should be in the same archetype (due to sparse)
    const archetypes = (world as any).archetypes;
    const matchingArchetypesBefore = archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId) && arch.componentTypes.includes(VelocityId);
    });
    expect(matchingArchetypesBefore.length).toBe(1);
    expect(matchingArchetypesBefore[0].size).toBe(3);

    // Verify relations exist
    expect(world.has(child1, relation(ChildOf, parent1))).toBe(true);
    expect(world.has(child2, relation(ChildOf, parent2))).toBe(true);
    expect(world.has(child3, relation(ChildOf, parent1))).toBe(true);

    // Delete parent1 - should remove relations from child1 and child3
    world.delete(parent1);
    world.sync();

    // Relations to parent1 should be removed
    expect(world.has(child1, relation(ChildOf, parent1))).toBe(false);
    expect(world.has(child3, relation(ChildOf, parent1))).toBe(false);

    // Relation to parent2 should still exist
    expect(world.has(child2, relation(ChildOf, parent2))).toBe(true);

    // Entities should still exist with their other components
    expect(world.exists(child1)).toBe(true);
    expect(world.exists(child2)).toBe(true);
    expect(world.exists(child3)).toBe(true);
    expect(world.has(child1, PositionId)).toBe(true);
    expect(world.has(child2, PositionId)).toBe(true);
    expect(world.has(child3, PositionId)).toBe(true);

    // Archetype should not fragment - entities without relations should move to a different archetype
    // (one without the wildcard marker)
    const matchingArchetypesAfter = archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId) && arch.componentTypes.includes(VelocityId);
    });

    // child1 and child3 no longer have ChildOf relations, so they should be in an archetype
    // without the wildcard marker, while child2 should be in the one with the marker
    expect(matchingArchetypesAfter.length).toBe(2);
  });

  it("should not create new archetypes when removing sparse relation from entity", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ sparse: true });

    const parent1 = world.new();
    const parent2 = world.new();

    // Create multiple children with different parents
    const children: EntityId[] = [];
    for (let i = 0; i < 5; i++) {
      const child = world.new();
      world.set(child, PositionId);
      world.set(child, relation(ChildOf, i % 2 === 0 ? parent1 : parent2));
      children.push(child);
    }

    world.sync();

    // Count archetypes before deletion
    const archetypesBefore = (world as any).archetypes.length;

    // Delete parent1 - this should remove relations but not fragment
    world.delete(parent1);
    world.sync();

    // Some children (those with parent1) should have lost their ChildOf relation
    // but the archetype structure should be minimal (not fragmented)
    const archetypesAfter = (world as any).archetypes.length;

    // We expect at most one new archetype (for entities without ChildOf)
    // The key point is we don't create separate archetypes per entity
    expect(archetypesAfter).toBeLessThanOrEqual(archetypesBefore + 1);

    // Verify entities still exist and have Position
    for (const child of children) {
      expect(world.exists(child)).toBe(true);
      expect(world.has(child, PositionId)).toBe(true);
    }
  });

  it("should trigger lifecycle hooks when sparse relations are removed due to entity destruction", () => {
    const world = new World();

    const ChildOf = component({ sparse: true });
    const PositionId = component();

    const parent = world.new();
    const child = world.new();
    world.set(child, PositionId);
    world.set(child, relation(ChildOf, parent));
    world.sync();

    // Set up hook to track removals
    const removedRelations: Array<{ entity: number; relations: [number, void][] }> = [];
    const wildcardChildOf = relation(ChildOf, "*");
    world.hook([wildcardChildOf], {
      on_remove: (entity, relations) => {
        removedRelations.push({ entity, relations });
      },
    });

    // Delete parent - should trigger hook for removed relation
    world.delete(parent);
    world.sync();

    // Hook should have been called
    expect(removedRelations.length).toBe(1);
    expect(removedRelations[0]!.entity).toBe(child);
    expect(removedRelations[0]!.relations).toEqual([[parent, undefined]]);
  });

  it("should handle cascade delete with sparse relations correctly", () => {
    const world = new World();

    const PositionId = component();
    // Cascade delete AND sparse - when parent dies, children die too
    const ChildOf = component({ sparse: true, cascadeDelete: true });

    const grandparent = world.new();
    const parent = world.new();
    world.set(parent, PositionId);
    world.set(parent, relation(ChildOf, grandparent));

    const child = world.new();
    world.set(child, PositionId);
    world.set(child, relation(ChildOf, parent));

    world.sync();

    // Verify hierarchy
    expect(world.exists(grandparent)).toBe(true);
    expect(world.exists(parent)).toBe(true);
    expect(world.exists(child)).toBe(true);

    // Delete grandparent - should cascade to parent, then to child
    world.delete(grandparent);
    world.sync();

    // All should be deleted due to cascade
    expect(world.exists(grandparent)).toBe(false);
    expect(world.exists(parent)).toBe(false);
    expect(world.exists(child)).toBe(false);
  });

  it("should maintain entity archetype integrity when removing sparse relations", () => {
    const world = new World();

    const PositionId = component<{ x: number; y: number }>();
    const VelocityId = component<{ vx: number; vy: number }>();
    const ChildOf = component({ sparse: true });

    const parent = world.new();

    // Create entity with components and sparse relation
    const entity = world.new();
    world.set(entity, PositionId, { x: 10, y: 20 });
    world.set(entity, VelocityId, { vx: 1, vy: 2 });
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Verify initial state
    expect(world.get(entity, PositionId)).toEqual({ x: 10, y: 20 });
    expect(world.get(entity, VelocityId)).toEqual({ vx: 1, vy: 2 });
    expect(world.has(entity, relation(ChildOf, parent))).toBe(true);

    // Delete parent - relation should be removed but other components preserved
    world.delete(parent);
    world.sync();

    // Entity should still exist with all other components intact
    expect(world.exists(entity)).toBe(true);
    expect(world.has(entity, relation(ChildOf, parent))).toBe(false);
    expect(world.get(entity, PositionId)).toEqual({ x: 10, y: 20 });
    expect(world.get(entity, VelocityId)).toEqual({ vx: 1, vy: 2 });
  });
});
