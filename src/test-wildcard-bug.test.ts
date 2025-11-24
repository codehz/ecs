import { describe, expect, it } from "bun:test";
import { component, relation } from "./entity";
import { World } from "./world";

describe("Wildcard Query Bug with DontFragment", () => {
  it("should query entities with wildcard relation on dontFragment component", () => {
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
