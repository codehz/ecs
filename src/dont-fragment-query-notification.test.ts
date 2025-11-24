import { describe, expect, it } from "bun:test";
import { component, relation } from "./entity";
import { World } from "./world";

describe("DontFragment Query Notification Issue", () => {
  it("should notify queries when new archetypes with dontFragment relations are created", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

    // Create a query BEFORE any entities with ChildOf relations exist
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Initially, no entities match
    expect(query.getEntities().length).toBe(0);

    // Now create entities with ChildOf relations
    const parent1 = world.new();
    const parent2 = world.new();

    const child1 = world.new();
    world.set(child1, PositionId);
    world.set(child1, relation(ChildOf, parent1));

    const child2 = world.new();
    world.set(child2, PositionId);
    world.set(child2, relation(ChildOf, parent2));

    world.sync();

    // The query should now find both children
    // This is the key test: the query was created before the archetype existed
    const entities = query.getEntities();
    expect(entities.length).toBe(2);
    expect(entities).toContain(child1);
    expect(entities).toContain(child2);
  });

  it("should separate archetypes with and without wildcard markers", () => {
    const world = new World();

    const PositionId = component();
    const VelocityId = component();
    const ChildOf = component({ dontFragment: true });

    // Create entities without ChildOf relation
    const entity1 = world.new();
    world.set(entity1, PositionId);
    world.set(entity1, VelocityId);

    world.sync();

    // Create a query for entities with ChildOf relation
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Entity1 should NOT match because it has no ChildOf relation
    expect(query.getEntities()).not.toContain(entity1);

    // Create entities with ChildOf relation
    const parent = world.new();
    const entity2 = world.new();
    world.set(entity2, PositionId);
    world.set(entity2, VelocityId);
    world.set(entity2, relation(ChildOf, parent));

    world.sync();

    // Now entity2 should match
    const entities = query.getEntities();
    expect(entities.length).toBe(1);
    expect(entities).toContain(entity2);
    expect(entities).not.toContain(entity1);

    // Verify they're in different archetypes
    const archetypes = (world as any).archetypes;
    const archetypesWithPosition = archetypes.filter((arch: any) => {
      return arch.componentTypes.includes(PositionId) && arch.componentTypes.includes(VelocityId);
    });

    // Should have 2 archetypes: one without wildcard marker, one with
    expect(archetypesWithPosition.length).toBe(2);

    // One archetype should have the wildcard marker
    const withMarker = archetypesWithPosition.filter((arch: any) => arch.componentTypes.includes(wildcardChildOf));
    expect(withMarker.length).toBe(1);

    // The other should not
    const withoutMarker = archetypesWithPosition.filter((arch: any) => !arch.componentTypes.includes(wildcardChildOf));
    expect(withoutMarker.length).toBe(1);
  });

  it("should handle adding dontFragment relations to existing entities", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

    // Create entity without ChildOf
    const entity = world.new();
    world.set(entity, PositionId);
    world.sync();

    // Create query for entities with ChildOf
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Entity should not match initially
    expect(query.getEntities()).not.toContain(entity);

    // Add ChildOf relation
    const parent = world.new();
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Entity should now match
    expect(query.getEntities()).toContain(entity);
  });

  it("should handle removing last dontFragment relation", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

    const parent = world.new();
    const entity = world.new();
    world.set(entity, PositionId);
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Create query
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Entity should match
    expect(query.getEntities()).toContain(entity);

    // Remove the relation
    world.remove(entity, relation(ChildOf, parent));
    world.sync();

    // Entity should no longer match
    expect(query.getEntities()).not.toContain(entity);

    // Verify entity moved to archetype without wildcard marker
    const archetype = (world as any).entityToArchetype.get(entity);
    expect(archetype.componentTypes).not.toContain(wildcardChildOf);
  });

  it("should handle multiple dontFragment relations on same entity", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true });

    const parent1 = world.new();
    const parent2 = world.new();
    const entity = world.new();

    world.set(entity, PositionId);
    world.set(entity, relation(ChildOf, parent1));
    world.set(entity, relation(ChildOf, parent2));
    world.sync();

    // Create query
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Entity should match
    expect(query.getEntities()).toContain(entity);

    // Remove one relation
    world.remove(entity, relation(ChildOf, parent1));
    world.sync();

    // Entity should still match (still has one relation)
    expect(query.getEntities()).toContain(entity);

    // Wildcard marker should still be present
    const archetype = (world as any).entityToArchetype.get(entity);
    expect(archetype.componentTypes).toContain(wildcardChildOf);

    // Remove the last relation
    world.remove(entity, relation(ChildOf, parent2));
    world.sync();

    // Entity should no longer match
    expect(query.getEntities()).not.toContain(entity);

    // Wildcard marker should be removed
    const newArchetype = (world as any).entityToArchetype.get(entity);
    expect(newArchetype.componentTypes).not.toContain(wildcardChildOf);
  });

  it("should allow false positives but filter correctly during iteration", () => {
    const world = new World();

    const PositionId = component();
    const TagA = component({ dontFragment: true });
    const TagB = component({ dontFragment: true });

    // Create entities with different dontFragment relations
    const parent1 = world.new();
    const parent2 = world.new();

    const entity1 = world.new();
    world.set(entity1, PositionId);
    world.set(entity1, relation(TagA, parent1));

    const entity2 = world.new();
    world.set(entity2, PositionId);
    world.set(entity2, relation(TagB, parent2));

    world.sync();

    // Both entities should be in the same archetype (Position + wildcard for TagA/TagB)
    // But queries should still work correctly
    const wildcardTagA = relation(TagA, "*");
    const queryA = world.createQuery([wildcardTagA, PositionId]);

    const wildcardTagB = relation(TagB, "*");
    const queryB = world.createQuery([wildcardTagB, PositionId]);

    // QueryA should only find entity1
    expect(queryA.getEntities()).toContain(entity1);
    expect(queryA.getEntities()).not.toContain(entity2);

    // QueryB should only find entity2
    expect(queryB.getEntities()).not.toContain(entity1);
    expect(queryB.getEntities()).toContain(entity2);
  });
});
