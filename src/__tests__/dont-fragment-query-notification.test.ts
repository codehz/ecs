import { describe, expect, it } from "bun:test";
import { component, relation } from "../core/entity";
import { World } from "../core/world";

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

  it("should handle repeated setting of the same dontFragment exclusive relation", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true, exclusive: true });

    const parent = world.new();
    const entity = world.new();
    world.set(entity, PositionId);

    // Create a wildcard query before setting relations
    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Initially, should not match
    expect(query.getEntities()).not.toContain(entity);

    // Set the relation for the first time
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Should now match
    expect(query.getEntities()).toContain(entity);
    expect(query.getEntities().length).toBe(1);

    // Repeat setting the same relation (second time)
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Should still match (not lost due to exclusive handling)
    expect(query.getEntities()).toContain(entity);
    expect(query.getEntities().length).toBe(1);

    // Set it one more time to be sure
    world.set(entity, relation(ChildOf, parent));
    world.sync();

    // Should still match
    expect(query.getEntities()).toContain(entity);
    expect(query.getEntities().length).toBe(1);
  });

  it("should handle changing exclusive relation target (replacing one relation with another)", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true, exclusive: true });

    const parent1 = world.new();
    const parent2 = world.new();
    const entity = world.new();
    world.set(entity, PositionId);

    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Set relation to parent1
    world.set(entity, relation(ChildOf, parent1));
    world.sync();

    expect(query.getEntities()).toContain(entity);
    expect(world.has(entity, relation(ChildOf, parent1))).toBe(true);
    expect(world.has(entity, relation(ChildOf, parent2))).toBe(false);

    // Change relation to parent2 (exclusive should remove parent1 relation)
    world.set(entity, relation(ChildOf, parent2));
    world.sync();

    expect(query.getEntities()).toContain(entity);
    expect(query.getEntities().length).toBe(1);
    expect(world.has(entity, relation(ChildOf, parent1))).toBe(false);
    expect(world.has(entity, relation(ChildOf, parent2))).toBe(true);
  });

  it("should handle specific relation query when target changes (non-dontFragment)", () => {
    const world = new World();

    const PositionId = component();
    // Note: Using non-dontFragment exclusive relation for specific queries
    const ChildOf = component({ exclusive: true });

    const parent1 = world.new();
    const parent2 = world.new();
    const entity = world.new();
    world.set(entity, PositionId);

    // Create specific queries for each parent
    const queryParent1 = world.createQuery([relation(ChildOf, parent1), PositionId]);
    const queryParent2 = world.createQuery([relation(ChildOf, parent2), PositionId]);

    // Set relation to parent1
    world.set(entity, relation(ChildOf, parent1));
    world.sync();

    expect(queryParent1.getEntities()).toContain(entity);
    expect(queryParent2.getEntities()).not.toContain(entity);

    // Change to parent2
    world.set(entity, relation(ChildOf, parent2));
    world.sync();

    expect(queryParent1.getEntities()).not.toContain(entity);
    expect(queryParent2.getEntities()).toContain(entity);

    // Change back to parent1
    world.set(entity, relation(ChildOf, parent1));
    world.sync();

    expect(queryParent1.getEntities()).toContain(entity);
    expect(queryParent2.getEntities()).not.toContain(entity);
  });

  it("should handle non-exclusive dontFragment relations with repeated setting", () => {
    const world = new World();

    const PositionId = component();
    const TaggedWith = component({ dontFragment: true }); // non-exclusive

    const tag1 = world.new();
    const tag2 = world.new();
    const entity = world.new();
    world.set(entity, PositionId);

    const wildcardTagged = relation(TaggedWith, "*");
    const query = world.createQuery([wildcardTagged, PositionId]);

    // Add first tag
    world.set(entity, relation(TaggedWith, tag1));
    world.sync();

    expect(query.getEntities()).toContain(entity);

    // Add second tag (non-exclusive allows multiple)
    world.set(entity, relation(TaggedWith, tag2));
    world.sync();

    expect(query.getEntities()).toContain(entity);
    expect(world.has(entity, relation(TaggedWith, tag1))).toBe(true);
    expect(world.has(entity, relation(TaggedWith, tag2))).toBe(true);

    // Re-set first tag (should not affect second tag)
    world.set(entity, relation(TaggedWith, tag1));
    world.sync();

    expect(query.getEntities()).toContain(entity);
    expect(world.has(entity, relation(TaggedWith, tag1))).toBe(true);
    expect(world.has(entity, relation(TaggedWith, tag2))).toBe(true);
  });

  it("should handle wildcard queries with has() checks for specific targets", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true, exclusive: true });

    const parent1 = world.new();
    const parent2 = world.new();
    const entity1 = world.new();
    const entity2 = world.new();

    world.set(entity1, PositionId);
    world.set(entity2, PositionId);

    // For dontFragment relations, use wildcard query and filter with has()
    const wildcardChildOf = relation(ChildOf, "*");
    const wildcardQuery = world.createQuery([wildcardChildOf, PositionId]);

    // Set entity1 -> parent1, entity2 -> parent2
    world.set(entity1, relation(ChildOf, parent1));
    world.set(entity2, relation(ChildOf, parent2));
    world.sync();

    expect(wildcardQuery.getEntities().length).toBe(2);
    expect(wildcardQuery.getEntities()).toContain(entity1);
    expect(wildcardQuery.getEntities()).toContain(entity2);

    // Filter for specific parent using has()
    const entitiesWithParent1 = wildcardQuery.getEntities().filter((e) => world.has(e, relation(ChildOf, parent1)));
    expect(entitiesWithParent1.length).toBe(1);
    expect(entitiesWithParent1).toContain(entity1);

    // Change entity1 from parent1 to parent2
    world.set(entity1, relation(ChildOf, parent2));
    world.sync();

    expect(wildcardQuery.getEntities().length).toBe(2);
    const entitiesWithParent1After = wildcardQuery
      .getEntities()
      .filter((e) => world.has(e, relation(ChildOf, parent1)));
    expect(entitiesWithParent1After.length).toBe(0);

    // Change entity1 back to parent1
    world.set(entity1, relation(ChildOf, parent1));
    world.sync();

    expect(wildcardQuery.getEntities().length).toBe(2);
    const entitiesWithParent1Final = wildcardQuery
      .getEntities()
      .filter((e) => world.has(e, relation(ChildOf, parent1)));
    expect(entitiesWithParent1Final.length).toBe(1);
    expect(entitiesWithParent1Final).toContain(entity1);
  });

  it("should preserve wildcard marker when switching between targets rapidly", () => {
    const world = new World();

    const PositionId = component();
    const ChildOf = component({ dontFragment: true, exclusive: true });

    const parents = [world.new(), world.new(), world.new()];
    const entity = world.new();
    world.set(entity, PositionId);

    const wildcardChildOf = relation(ChildOf, "*");
    const query = world.createQuery([wildcardChildOf, PositionId]);

    // Rapidly switch between different parents
    for (let i = 0; i < 10; i++) {
      const parent = parents[i % parents.length]!;
      world.set(entity, relation(ChildOf, parent));
      world.sync();

      expect(query.getEntities()).toContain(entity);
      expect(query.getEntities().length).toBe(1);
      expect(world.has(entity, relation(ChildOf, parent))).toBe(true);

      // Verify wildcard marker is still in archetype
      const archetype = (world as any).entityToArchetype.get(entity);
      expect(archetype.componentTypes).toContain(wildcardChildOf);
    }
  });
});
