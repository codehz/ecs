import { describe, expect, it } from "bun:test";
import { Archetype } from "./archetype";
import { component, createEntityId, relation, type EntityId } from "./entity";

describe("Archetype", () => {
  type Position = { x: number; y: number };
  type Velocity = { x: number; y: number };

  const positionComponent = component<Position>();
  const velocityComponent = component<Velocity>();

  // Helper function to create a dontFragmentRelations map for testing
  const createDontFragmentRelations = () => new Map<EntityId, Map<EntityId<any>, any>>();

  it("should create an archetype with component types", () => {
    const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
    expect(archetype.componentTypes).toEqual([positionComponent, velocityComponent]);
    expect(archetype.size).toBe(0);
  });

  it("should match component types", () => {
    const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
    expect(archetype.matches([positionComponent, velocityComponent])).toBe(true);
    expect(archetype.matches([velocityComponent, positionComponent])).toBe(true); // Order doesn't matter
    expect(archetype.matches([positionComponent])).toBe(false);
  });

  it("should add and remove entities", () => {
    const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
    const entity1 = createEntityId(1024);
    const entity2 = createEntityId(1025);

    const componentData1 = new Map([
      [positionComponent, { x: 0, y: 0 }],
      [velocityComponent, { x: 1, y: 1 }],
    ]);

    const componentData2 = new Map([
      [positionComponent, { x: 10, y: 10 }],
      [velocityComponent, { x: 2, y: 2 }],
    ]);

    archetype.addEntity(entity1, componentData1);
    expect(archetype.size).toBe(1);
    expect(archetype.exists(entity1)).toBe(true);

    archetype.addEntity(entity2, componentData2);
    expect(archetype.size).toBe(2);
    expect(archetype.exists(entity2)).toBe(true);

    const removedData = archetype.removeEntity(entity1);
    expect(archetype.size).toBe(1);
    expect(archetype.exists(entity1)).toBe(false);
    expect(removedData).toEqual(componentData1);
  });

  it("should get and set component data", () => {
    const archetype = new Archetype([positionComponent], createDontFragmentRelations());
    const entity = createEntityId(1024);
    const initialPosition: Position = { x: 5, y: 5 };

    archetype.addEntity(entity, new Map([[positionComponent, initialPosition]]));

    const retrieved = archetype.get(entity, positionComponent);
    expect(retrieved).toEqual(initialPosition);

    const newPosition: Position = { x: 10, y: 10 };
    archetype.set(entity, positionComponent, newPosition);
    const retrieved2 = archetype.get(entity, positionComponent);
    expect(retrieved2).toEqual(newPosition);
  });

  it("should get wildcard relation components", () => {
    // Create relation component types
    const target1 = createEntityId(1027);
    const target2 = createEntityId(1028);
    const relation1 = relation(positionComponent, target1);
    const relation2 = relation(positionComponent, target2);
    const wildcardPositionRelation = relation(positionComponent, "*");

    const entity = createEntityId(1024);

    // Archetype with multiple relations
    const archetype = new Archetype([relation1, relation2], createDontFragmentRelations());

    // Add entity with relations to target1 and target2
    archetype.addEntity(
      entity,
      new Map([
        [relation1, { distance: 10 }],
        [relation2, { distance: 20 }],
      ]),
    );

    // Get wildcard relations
    const relations = archetype.get(entity, wildcardPositionRelation);
    expect(relations).toEqual([
      [target2, { distance: 20 }],
      [target1, { distance: 10 }],
    ]);

    // Test with entity not in archetype
    const nonExistentEntity = createEntityId(9999);
    expect(() => archetype.get(nonExistentEntity, wildcardPositionRelation)).toThrow(
      "Entity 9999 is not in this archetype",
    );
  });

  it("should iterate over entities", () => {
    const archetype = new Archetype([positionComponent], createDontFragmentRelations());
    const entity1 = createEntityId(1024);
    const entity2 = createEntityId(1025);

    archetype.addEntity(entity1, new Map([[positionComponent, { x: 1, y: 1 }]]));
    archetype.addEntity(entity2, new Map([[positionComponent, { x: 2, y: 2 }]]));

    const iteratedEntities: EntityId[] = [];
    archetype.forEach((entityId, components) => {
      iteratedEntities.push(entityId);
    });

    expect(iteratedEntities).toEqual([entity1, entity2]);
  });

  it("should get component data arrays", () => {
    const archetype = new Archetype([positionComponent], createDontFragmentRelations());
    const entity1 = createEntityId(1024);
    const entity2 = createEntityId(1025);
    const pos1: Position = { x: 1, y: 1 };
    const pos2: Position = { x: 2, y: 2 };

    archetype.addEntity(entity1, new Map([[positionComponent, pos1]]));
    archetype.addEntity(entity2, new Map([[positionComponent, pos2]]));

    const data = archetype.getComponentData(positionComponent);
    expect(data).toEqual([pos1, pos2]);
  });

  it("should handle wildcard relations in forEachWithComponents", () => {
    // Create a relation component type: position relation from entity to entity
    const positionRelation = relation(positionComponent, createEntityId(1026)); // Dummy target for type
    const wildcardPositionRelation = relation(positionComponent, "*");

    const entity1 = createEntityId(1024);
    const entity2 = createEntityId(1025);
    const target1 = createEntityId(1027);
    const target2 = createEntityId(1028);

    // Create specific relations for entity1 and entity2
    const relation1 = relation(positionComponent, target1);
    const relation2 = relation(positionComponent, target2);
    const relation3 = relation(positionComponent, createEntityId(1029)); // For entity2

    // Archetype with multiple relations
    const archetype1 = new Archetype([relation1, relation2], createDontFragmentRelations());
    const archetype2 = new Archetype([relation3], createDontFragmentRelations());

    // Add entity1 with relations to target1 and target2
    archetype1.addEntity(
      entity1,
      new Map([
        [relation1, { distance: 10 }],
        [relation2, { distance: 20 }],
      ]),
    );

    // Add entity2 with relation to another target
    archetype2.addEntity(entity2, new Map([[relation3, { distance: 30 }]]));

    // Test forEachWithComponents with wildcard relation on archetype1
    const results: Array<{ entity: EntityId; relations: [EntityId<any>, any][] }> = [];
    archetype1.forEachWithComponents([wildcardPositionRelation], (entity, relations) => {
      results.push({ entity, relations });
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.entity).toBe(entity1);
    expect(results[0]!.relations).toEqual([
      [target2, { distance: 20 }],
      [target1, { distance: 10 }],
    ]);

    // Test on archetype2
    const results2: Array<{ entity: EntityId; relations: [EntityId<any>, any][] }> = [];
    archetype2.forEachWithComponents([wildcardPositionRelation], (entity, relations) => {
      results2.push({ entity, relations });
    });

    expect(results2).toHaveLength(1);
    expect(results2[0]!.entity).toBe(entity2);
    expect(results2[0]!.relations).toEqual([[createEntityId(1029), { distance: 30 }]]);
  });

  it("should cache componentDataArrays correctly", () => {
    // Test with wildcard relations to check cache invalidation
    const target1 = createEntityId(1027);
    const target2 = createEntityId(1028);
    const relation1 = relation(positionComponent, target1);
    const relation2 = relation(positionComponent, target2);
    const wildcardPositionRelation = relation(positionComponent, "*");

    const archetype = new Archetype([relation1, relation2], createDontFragmentRelations());

    const entity1 = createEntityId(1024);

    archetype.addEntity(
      entity1,
      new Map([
        [relation1, { distance: 10 }],
        [relation2, { distance: 20 }],
      ]),
    );

    // First call - should compute and cache
    let results1: [EntityId<any>, any][][] = [];
    archetype.forEachWithComponents([wildcardPositionRelation], (entity, relations) => {
      results1.push(relations);
    });
    expect(results1[0]).toEqual([
      [target2, { distance: 20 }],
      [target1, { distance: 10 }],
    ]);

    // Second call - should use cache
    let results2: [EntityId<any>, any][][] = [];
    archetype.forEachWithComponents([wildcardPositionRelation], (entity, relations) => {
      results2.push(relations);
    });
    expect(results2[0]).toEqual([
      [target2, { distance: 20 }],
      [target1, { distance: 10 }],
    ]);

    // Modify data
    (archetype as any).set(entity1, relation1, { distance: 100 });

    // Third call - should still use cache (data is computed dynamically)
    let results3: [EntityId<any>, any][][] = [];
    archetype.forEachWithComponents([wildcardPositionRelation], (entity, relations) => {
      results3.push(relations);
    });
    // Since cache stores structure and data is computed dynamically, this should show updated data
    expect(results3[0]).toEqual([
      [target2, { distance: 20 }],
      [target1, { distance: 100 }], // Updated
    ]);
  });
});
