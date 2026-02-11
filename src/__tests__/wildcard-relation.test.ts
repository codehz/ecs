import { describe, expect, it } from "bun:test";
import { component, relation } from "../core/entity";
import { World } from "../core/world";

describe("Wildcard relation edge cases", () => {
  it("should handle empty wildcard matches", () => {
    const world = new World();
    const Likes = component<any>();
    const entity = world.new();

    // Query wildcard relation but entity has no relations
    const results = world.get(entity, relation(Likes, "*"));
    expect(results).toEqual([]);
  });

  it("should get wildcard relations with data", () => {
    const world = new World();
    const Follows = component<{ level: number }>();
    const entity = world.new();
    const target1 = world.new();
    const target2 = world.new();

    // Add relations with data
    world.set(entity, relation(Follows, target1), { level: 1 });
    world.set(entity, relation(Follows, target2), { level: 2 });
    world.sync();

    const results = world.get(entity, relation(Follows, "*"));
    expect(results).toHaveLength(2);
    expect(results.map((r: any) => r[0])).toContain(target1);
    expect(results.map((r: any) => r[0])).toContain(target2);
  });

  it("should handle large number of wildcard relations", () => {
    const world = new World();
    const Likes = component<{ strength: number }>();
    const entity = world.new();

    // Create 100 relations
    const targets = [];
    for (let i = 0; i < 100; i++) {
      const target = world.new();
      targets.push(target);
      world.set(entity, relation(Likes, target), { strength: i });
    }

    world.sync();

    // Query all wildcard relations
    const results = world.get(entity, relation(Likes, "*"));
    expect(results).toHaveLength(100);

    // Verify structure
    for (const [target, data] of results) {
      expect(targets).toContain(target);
      expect(data.strength).toBeGreaterThanOrEqual(0);
      expect(data.strength).toBeLessThan(100);
    }
  });

  it("should remove wildcard relations correctly", () => {
    const world = new World();
    const Owns = component<{ quantity: number }>();
    const entity = world.new();
    const target1 = world.new();
    const target2 = world.new();

    world.set(entity, relation(Owns, target1), { quantity: 5 });
    world.set(entity, relation(Owns, target2), { quantity: 3 });
    world.sync();

    expect(world.get(entity, relation(Owns, "*"))).toHaveLength(2);

    // Remove all wildcard relations
    world.remove(entity, relation(Owns, "*"));
    world.sync();

    const results = world.get(entity, relation(Owns, "*"));
    expect(results).toEqual([]);

    // Verify specific relations are also gone
    expect(world.has(entity, relation(Owns, target1))).toBe(false);
    expect(world.has(entity, relation(Owns, target2))).toBe(false);
  });

  it("should update wildcard relations", () => {
    const world = new World();
    const Knows = component<{ years: number }>();
    const entity = world.new();
    const target = world.new();

    world.set(entity, relation(Knows, target), { years: 1 });
    world.sync();

    const initialResult = world.get(entity, relation(Knows, "*"));
    expect(initialResult).toHaveLength(1);
    expect(initialResult[0]![1]).toEqual({ years: 1 });

    // Update the relation
    world.set(entity, relation(Knows, target), { years: 5 });
    world.sync();

    const updatedResult = world.get(entity, relation(Knows, "*"));
    expect(updatedResult).toHaveLength(1);
    expect(updatedResult[0]![1]).toEqual({ years: 5 });
  });

  it("should handle dontFragment wildcard relations", () => {
    const world = new World();
    const Follows = component<{ data: number }>({ dontFragment: true });
    const entity1 = world.new();
    const entity2 = world.new();
    const target1 = world.new();
    const target2 = world.new();

    // Add different wildcard relations to different entities
    world.set(entity1, relation(Follows, target1), { data: 1 });
    world.set(entity2, relation(Follows, target2), { data: 2 });
    world.sync();

    // Query both wildcards
    const results1 = world.get(entity1, relation(Follows, "*"));
    const results2 = world.get(entity2, relation(Follows, "*"));

    expect(results1).toHaveLength(1);
    expect(results2).toHaveLength(1);

    // Both entities should be in the same archetype (dontFragment behavior)
    const archetype1 = (world as any).entityToArchetype.get(entity1);
    const archetype2 = (world as any).entityToArchetype.get(entity2);
    expect(archetype1).toBe(archetype2);
  });

  it("should handle exclusive wildcard relations", () => {
    const world = new World();
    const ChildOf = component<{ priority: number }>({ exclusive: true });
    const entity = world.new();
    const parent1 = world.new();
    const parent2 = world.new();

    world.set(entity, relation(ChildOf, parent1), { priority: 1 });
    world.sync();

    const results1 = world.get(entity, relation(ChildOf, "*"));
    expect(results1).toHaveLength(1);

    // Set another parent - should replace the first due to exclusive
    world.set(entity, relation(ChildOf, parent2), { priority: 2 });
    world.sync();

    const results2 = world.get(entity, relation(ChildOf, "*"));
    expect(results2).toHaveLength(1);
    expect(results2[0]![0]).toBe(parent2);
  });

  it("should mix specific and wildcard queries", () => {
    const world = new World();
    const Relates = component<{ value: number }>();
    const entity = world.new();
    const target1 = world.new();
    const target2 = world.new();

    world.set(entity, relation(Relates, target1), { value: 10 });
    world.set(entity, relation(Relates, target2), { value: 20 });
    world.sync();

    // Get specific relation
    expect(world.has(entity, relation(Relates, target1))).toBe(true);
    expect(world.get(entity, relation(Relates, target1))).toEqual({ value: 10 });

    // Get all via wildcard
    const all = world.get(entity, relation(Relates, "*"));
    expect(all).toHaveLength(2);

    // Get specific relation again
    expect(world.has(entity, relation(Relates, target2))).toBe(true);
    expect(world.get(entity, relation(Relates, target2))).toEqual({ value: 20 });
  });
});
