import { describe, expect, it } from "bun:test";
import { component, relation } from "../core/entity";
import { World } from "../core/world";

describe("DontFragment Query Notification Issue", () => {
  it("should handle dontFragment wildcard queries and archetype lifecycle", () => {
    const world = new World();
    const Position = component();
    const ChildOf = component({ dontFragment: true });
    const WildcardChildOf = relation(ChildOf, "*");

    const query = world.createQuery([WildcardChildOf, Position]);
    expect(query.getEntities().length).toBe(0);

    const parent1 = world.new();
    const child1 = world.new();
    world.set(child1, Position);
    world.set(child1, relation(ChildOf, parent1));
    world.sync();

    // Verify entity is found and archetype has wildcard marker
    expect(query.getEntities()).toContain(child1);
    const arch1 = (world as any).entityToArchetype.get(child1);
    expect(arch1.componentTypes).toContain(WildcardChildOf);

    // Verify archetype separation: entity without relation shouldn't match
    const entityWithout = world.new();
    world.set(entityWithout, Position);
    world.sync();
    expect(query.getEntities()).not.toContain(entityWithout);
    expect((world as any).entityToArchetype.get(entityWithout)).not.toBe(arch1);

    // Add relation to existing entity
    const parent2 = world.new();
    world.set(entityWithout, relation(ChildOf, parent2));
    world.sync();
    expect(query.getEntities()).toContain(entityWithout);

    // Remove relation: marker should disappear when last one is gone
    world.remove(child1, relation(ChildOf, parent1));
    world.sync();
    expect(query.getEntities()).not.toContain(child1);
    expect((world as any).entityToArchetype.get(child1).componentTypes).not.toContain(WildcardChildOf);
  });

  it("should handle exclusive dontFragment relations and specific target queries", () => {
    const world = new World();
    const ChildOf = component({ dontFragment: true, exclusive: true });
    const p1 = world.new();
    const p2 = world.new();
    const entity = world.new();

    const queryP1 = world.createQuery([relation(ChildOf, p1)]);
    const queryP2 = world.createQuery([relation(ChildOf, p2)]);

    // Set p1
    world.set(entity, relation(ChildOf, p1));
    world.sync();
    expect(queryP1.getEntities()).toContain(entity);
    expect(queryP2.getEntities()).not.toContain(entity);

    // Re-set p1 (no-op/stable)
    world.set(entity, relation(ChildOf, p1));
    world.sync();
    expect(queryP1.getEntities().length).toBe(1);

    // Switch to p2
    world.set(entity, relation(ChildOf, p2));
    world.sync();
    expect(queryP1.getEntities()).not.toContain(entity);
    expect(queryP2.getEntities()).toContain(entity);

    // Wildcard query should still work
    const wildcardQuery = world.createQuery([relation(ChildOf, "*")]);
    expect(wildcardQuery.getEntities()).toContain(entity);
  });

  it("should handle multiple non-exclusive dontFragment relations", () => {
    const world = new World();
    const Tag = component({ dontFragment: true });
    const t1 = world.new();
    const t2 = world.new();
    const entity = world.new();
    const wildcardQuery = world.createQuery([relation(Tag, "*")]);

    world.set(entity, relation(Tag, t1));
    world.set(entity, relation(Tag, t2));
    world.sync();

    expect(wildcardQuery.getEntities().length).toBe(1);
    expect(world.has(entity, relation(Tag, t1))).toBe(true);
    expect(world.has(entity, relation(Tag, t2))).toBe(true);

    world.remove(entity, relation(Tag, t1));
    world.sync();
    expect(wildcardQuery.getEntities().length).toBe(1);
    expect(world.has(entity, relation(Tag, t1))).toBe(false);

    world.remove(entity, relation(Tag, t2));
    world.sync();
    expect(wildcardQuery.getEntities().length).toBe(0);
  });

  it("should correctly filter false positives in wildcard queries", () => {
    const world = new World();
    const TagA = component({ dontFragment: true });
    const TagB = component({ dontFragment: true });
    const p = world.new();

    const e1 = world.new();
    world.set(e1, relation(TagA, p));
    const e2 = world.new();
    world.set(e2, relation(TagB, p));
    world.sync();

    // QueryA should only find e1, QueryB should only find e2
    const queryA = world.createQuery([relation(TagA, "*")]);
    const queryB = world.createQuery([relation(TagB, "*")]);

    expect(queryA.getEntities()).toContain(e1);
    expect(queryA.getEntities()).not.toContain(e2);
    expect(queryB.getEntities()).toContain(e2);
    expect(queryB.getEntities()).not.toContain(e1);
  });
});
