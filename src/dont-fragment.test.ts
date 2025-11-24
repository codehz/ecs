import { describe, expect, it } from "bun:test";
import { component, relation } from "./entity";
import { World } from "./world";

describe("DontFragment Relations", () => {
  it("should prevent archetype fragmentation for dontFragment relations", () => {
    const world = new World();

    // Create component types
    type Position = { x: number; y: number };
    const PositionId = component<Position>();
    const VelocityId = component();

    // Create ChildOf with dontFragment option
    const ChildOf = component({ dontFragment: true });

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

    // Verify all children are in the same archetype
    // This is the key benefit: despite having different parent relations,
    // they share the same archetype because ChildOf is marked as dontFragment
    const archetypes = (world as any).archetypes;

    // Count archetypes with Position and Velocity
    const matchingArchetypes = archetypes.filter((arch: any) => {
      const types = arch.componentTypes;
      return types.includes(PositionId) && types.includes(VelocityId);
    });

    // All three children should be in the SAME archetype
    expect(matchingArchetypes.length).toBe(1);
    expect(matchingArchetypes[0].size).toBe(3);

    // Verify we can still access the relations
    expect(world.has(child1, relation(ChildOf, parent1))).toBe(true);
    expect(world.has(child2, relation(ChildOf, parent2))).toBe(true);
    expect(world.has(child3, relation(ChildOf, parent3))).toBe(true);

    // Verify queries still work
    const entities = world.query([PositionId, VelocityId]);
    expect(entities.length).toBe(3);
  });

  it("should handle dontFragment relations with wildcard queries", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

    const parent1 = world.new();
    const parent2 = world.new();

    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, relation(ChildOf, parent2));

    world.sync();

    // Wildcard query should work with dontFragment relations
    const wildcardChildOf = relation(ChildOf, "*");
    const child1Relations = world.get(child1, wildcardChildOf);
    const child2Relations = world.get(child2, wildcardChildOf);

    expect(child1Relations.length).toBe(1);
    expect(child1Relations[0]![0]).toBe(parent1);

    expect(child2Relations.length).toBe(1);
    expect(child2Relations[0]![0]).toBe(parent2);
  });

  it("should allow updating dontFragment relations", () => {
    const world = new World();

    const ChildOf = component({ dontFragment: true, exclusive: true });
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

    // Archetype should remain the same
    const archetypes = (world as any).archetypes;
    const matchingArchetypes = archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId);
    });
    expect(matchingArchetypes.length).toBe(1);
  });

  it("should handle removing dontFragment relations", () => {
    const world = new World();

    const ChildOf = component({ dontFragment: true });
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

  it("should handle queries with dontFragment relations", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ dontFragment: true });

    const parent1 = world.new();
    const parent2 = world.new();

    // Create entities with dontFragment relations
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

    // All should be in the same archetype
    const archetypes = (world as any).archetypes;
    const matchingArchetypes = archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId) && arch.componentTypes.includes(VelocityId);
    });
    expect(matchingArchetypes.length).toBe(1);
  });

  it("should compare fragmentation: with and without dontFragment", () => {
    // Test WITHOUT dontFragment (causes fragmentation)
    const world1 = new World();
    const PositionId1 = component();
    const ChildOf1 = component(); // No dontFragment

    for (let i = 0; i < 5; i++) {
      const parent = world1.new();
      const child = world1.new();
      world1.set(child, PositionId1);
      world1.set(child, relation(ChildOf1, parent));
    }
    world1.sync();

    const archetypes1 = (world1 as any).archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId1);
    });

    // Test WITH dontFragment (prevents fragmentation)
    const world2 = new World();
    const PositionId2 = component();
    const ChildOf2 = component({ dontFragment: true }); // With dontFragment

    for (let i = 0; i < 5; i++) {
      const parent = world2.new();
      const child = world2.new();
      world2.set(child, PositionId2);
      world2.set(child, relation(ChildOf2, parent));
    }
    world2.sync();

    const archetypes2 = (world2 as any).archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId2);
    });

    // Without dontFragment: 5 archetypes (one per parent)
    expect(archetypes1.length).toBe(5);

    // With dontFragment: 1 archetype (all children share it)
    expect(archetypes2.length).toBe(1);
    expect(archetypes2[0].size).toBe(5);
  });

  it("should query entities with wildcard relation on dontFragment component using createQuery", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

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

  it("should query entities with wildcard relation + other components on dontFragment", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ dontFragment: true });

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
});
