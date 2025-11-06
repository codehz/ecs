import { describe, expect, it } from "bun:test";
import { component, createEntityId, relation, type EntityId } from "./entity";
import { World } from "./world";

describe("World", () => {
  describe("Entity Management", () => {
    it("should create entities", () => {
      const world = new World();
      const entity1 = world.new();
      const entity2 = world.new();

      expect(world.exists(entity1)).toBe(true);
      expect(world.exists(entity2)).toBe(true);
      expect(entity1).not.toBe(entity2);
    });

    it("should destroy entities", () => {
      const world = new World();
      const entity = world.new();
      expect(world.exists(entity)).toBe(true);

      world.destroy(entity);
      world.sync();
      expect(world.exists(entity)).toBe(false);
    });

    it("should handle destroying non-existent entities gracefully", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);
      expect(world.exists(fakeEntity)).toBe(false);
      // Should not throw
      world.destroy(fakeEntity);
    });
  });

  describe("Component Management", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();

    it("should add components to entities", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      world.set(entity, positionComponent, position);
      world.sync(); // Execute deferred commands

      expect(world.has(entity, positionComponent)).toBe(true);
      expect(world.get(entity, positionComponent)).toEqual(position);
    });

    it("should update existing components", () => {
      const world = new World();
      const entity = world.new();
      const position1: Position = { x: 10, y: 20 };
      const position2: Position = { x: 30, y: 40 };

      world.set(entity, positionComponent, position1);
      world.sync();
      expect(world.get(entity, positionComponent)).toEqual(position1);

      world.set(entity, positionComponent, position2);
      world.sync();
      expect(world.get(entity, positionComponent)).toEqual(position2);
    });

    it("should remove components from entities", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      world.set(entity, positionComponent, position);
      world.sync();
      expect(world.has(entity, positionComponent)).toBe(true);

      world.delete(entity, positionComponent);
      world.sync();
      expect(world.has(entity, positionComponent)).toBe(false);
      expect(() => world.get(entity, positionComponent)).toThrow(
        /^Entity \d+ does not have component \d+\. Use has\(\) to check component existence before calling get\(\)\.$/,
      );
    });

    it("should throw error when removing invalid component type", () => {
      const world = new World();
      const entity = world.new();
      const invalidComponentType = 0 as EntityId<any>; // Invalid component ID

      expect(() => world.delete(entity, invalidComponentType)).toThrow("Invalid component type: 0");
    });

    it("should allow removing wildcard relation components", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };
      const targetEntity1 = world.new();
      const targetEntity2 = world.new();
      const relationId1 = relation(positionComponent, targetEntity1);
      const relationId2 = relation(positionComponent, targetEntity2);

      // Add multiple relation components with the same base component
      world.set(entity, relationId1, position);
      world.set(entity, relationId2, { x: 20, y: 30 });
      world.sync();
      expect(world.has(entity, relationId1)).toBe(true);
      expect(world.has(entity, relationId2)).toBe(true);

      // Remove using wildcard relation should remove all matching components
      const wildcardRelation = relation(positionComponent, "*");
      world.delete(entity, wildcardRelation);
      world.sync();
      expect(world.has(entity, relationId1)).toBe(false);
      expect(world.has(entity, relationId2)).toBe(false);
    });

    it("should get wildcard relation components", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };
      const targetEntity1 = world.new();
      const targetEntity2 = world.new();
      const relationId1 = relation(positionComponent, targetEntity1);
      const relationId2 = relation(positionComponent, targetEntity2);

      // Add multiple relation components with the same base component
      world.set(entity, relationId1, position);
      world.set(entity, relationId2, { x: 20, y: 30 });
      world.sync();

      // Get wildcard relations
      const wildcardRelation = relation(positionComponent, "*");
      const relations = world.get(entity, wildcardRelation);
      expect(relations).toEqual([
        [targetEntity2, { x: 20, y: 30 }],
        [targetEntity1, { x: 10, y: 20 }],
      ]);

      // Test with entity not having components
      const otherEntity = world.new();
      const result = world.get(otherEntity, wildcardRelation);
      expect(result).toEqual([]);
    });

    it("should handle exclusive relations", () => {
      const world = new World();
      const entity = world.new();
      const parent1 = world.new();
      const parent2 = world.new();

      // Mark ChildOf as exclusive
      const ChildOf = component();
      world.setExclusive(ChildOf);

      const childOfParent1 = relation(ChildOf, parent1);
      const childOfParent2 = relation(ChildOf, parent2);

      // Add first relation
      world.set(entity, childOfParent1);
      world.sync();
      expect(world.has(entity, childOfParent1)).toBe(true);
      expect(world.has(entity, childOfParent2)).toBe(false);

      // Add second relation - should replace the first
      world.set(entity, childOfParent2);
      world.sync();
      expect(world.has(entity, childOfParent1)).toBe(false);
      expect(world.has(entity, childOfParent2)).toBe(true);
    });

    it("should handle multiple components", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };
      const velocity: Velocity = { x: 1, y: 2 };

      world.set(entity, positionComponent, position);
      world.set(entity, velocityComponent, velocity);
      world.sync();

      expect(world.has(entity, positionComponent)).toBe(true);
      expect(world.has(entity, velocityComponent)).toBe(true);
      expect(world.get(entity, positionComponent)).toEqual(position);
      expect(world.get(entity, velocityComponent)).toEqual(velocity);
    });

    it("should throw error when adding component to non-existent entity", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);
      const position: Position = { x: 10, y: 20 };

      expect(() => world.set(fakeEntity, positionComponent, position)).toThrow("Entity 9999 does not exist");
    });

    it("should throw error when adding invalid component type", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };
      const invalidComponentType = 0 as EntityId<any>; // Invalid component ID

      expect(() => world.set(entity, invalidComponentType, position)).toThrow("Invalid component type: 0");
    });

    it("should throw error when adding wildcard relation component", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };
      const wildcardRelation = relation(positionComponent, "*");

      expect(() => world.set(entity, wildcardRelation, position)).toThrow(
        "Cannot directly add wildcard relation components",
      );
    });

    it("should throw error when getting component from non-existent entity", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);

      expect(() => world.get(fakeEntity, positionComponent)).toThrow("Entity 9999 does not exist");
    });

    it("should allow setting undefined as component data", () => {
      const world = new World();
      const entity = world.new();

      const optionalPositionComponent = component<Position | undefined>();

      // Add component with undefined data
      world.set(entity, optionalPositionComponent, undefined);
      world.sync();

      expect(world.has(entity, optionalPositionComponent)).toBe(true);
      expect(world.get(entity, optionalPositionComponent)).toBeUndefined();

      // Update to a defined value
      const position: Position = { x: 10, y: 20 };
      world.set(entity, optionalPositionComponent, position);
      world.sync();
      expect(world.get(entity, optionalPositionComponent)).toEqual(position);

      // Update back to undefined
      world.set(entity, optionalPositionComponent, undefined);
      world.sync();
      expect(world.get(entity, optionalPositionComponent)).toBeUndefined();
    });
  });

  describe("System Management", () => {
    it("should register systems", () => {
      const world = new World<[deltaTime: number]>();
      const system = { update: (dt: number) => {} };

      world.registerSystem(system);
      // Update should not throw
      world.update(0.016);
    });

    it("should call system update methods", () => {
      const world = new World<[deltaTime: number]>();
      let updateCalled = false;
      const system = {
        update: (dt: number) => {
          updateCalled = true;
          expect(dt).toBe(0.016);
        },
      };

      world.registerSystem(system);
      world.update(0.016);

      expect(updateCalled).toBe(true);
    });

    it("should execute systems in dependency order", () => {
      const world = new World<[deltaTime: number]>();
      const executionOrder: string[] = [];

      const systemA = {
        update: (dt: number) => executionOrder.push("A"),
      };
      const systemB = {
        update: (dt: number) => executionOrder.push("B"),
        dependencies: [systemA],
      };
      const systemC = {
        update: (dt: number) => executionOrder.push("C"),
        dependencies: [systemB],
      };

      // C depends on B, B depends on A
      world.registerSystem(systemA);
      world.registerSystem(systemB);
      world.registerSystem(systemC);

      world.update(0.016);

      expect(executionOrder).toEqual(["A", "B", "C"]);
    });
  });

  describe("Query", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();

    it("should query entities with specific components", () => {
      const world = new World();
      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });

      // entity3 has no components

      world.sync(); // Execute deferred commands

      const positionEntities = world.query([positionComponent]);
      expect(positionEntities).toContain(entity1);
      expect(positionEntities).toContain(entity2);
      expect(positionEntities).not.toContain(entity3);

      const velocityEntities = world.query([velocityComponent]);
      expect(velocityEntities).toContain(entity1);
      expect(velocityEntities).not.toContain(entity2);
      expect(velocityEntities).not.toContain(entity3);

      const bothEntities = world.query([positionComponent, velocityComponent]);
      expect(bothEntities).toContain(entity1);
      expect(bothEntities).not.toContain(entity2);
      expect(bothEntities).not.toContain(entity3);
    });

    it("should return empty array for queries with no matches", () => {
      const world = new World();
      const entity = world.new();
      world.set(entity, positionComponent, { x: 1, y: 2 });

      const result = world.query([velocityComponent]);
      expect(result).toEqual([]);
    });

    it("should query entities with wildcard relations", () => {
      const world = new World();
      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      // Create a wildcard relation for position component
      const wildcardPositionRelation = relation(positionComponent, "*");

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });

      // entity3 has no position component

      world.sync(); // Execute deferred commands

      // Query with wildcard relation should find all entities with position component
      const wildcardEntities = world.query([wildcardPositionRelation]);
      expect(wildcardEntities).toContain(entity1);
      expect(wildcardEntities).toContain(entity2);
      expect(wildcardEntities).not.toContain(entity3);
    });

    it("should query entities with mixed component and wildcard relation queries", () => {
      const world = new World();
      const entity1 = world.new();
      const entity2 = world.new();
      const entity3 = world.new();

      // Create a wildcard relation for position component
      const wildcardPositionRelation = relation(positionComponent, "*");

      world.set(entity1, positionComponent, { x: 1, y: 2 });
      world.set(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.set(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 doesn't have velocity

      world.set(entity3, velocityComponent, { x: 0.5, y: 0.6 });
      // entity3 doesn't have position

      world.sync(); // Execute deferred commands

      // Query with both velocity component and wildcard position relation
      // Should only match entity1 (has both position and velocity)
      const mixedEntities = world.query([velocityComponent, wildcardPositionRelation]);
      expect(mixedEntities).toContain(entity1);
      expect(mixedEntities).not.toContain(entity2);
      expect(mixedEntities).not.toContain(entity3);
    });

    it("should clean up relation components when target entity is destroyed", () => {
      const world = new World();

      // Create component IDs
      const positionComponent = component<{ x: number; y: number }>();
      const followsComponent = component<void>();

      // Create entities
      const entity1 = world.new(); // This will be followed
      const entity2 = world.new(); // This will follow entity1
      const entity3 = world.new(); // This will also follow entity1

      // Add position to entity1
      world.set(entity1, positionComponent, { x: 10, y: 20 });
      world.sync();

      // Create relation components (entity2 and entity3 follow entity1)
      const followsEntity1 = relation(followsComponent, entity1);
      world.set(entity2, followsEntity1);
      world.set(entity3, followsEntity1);
      world.sync();

      // Verify relations exist
      expect(world.has(entity2, followsEntity1)).toBe(true);
      expect(world.has(entity3, followsEntity1)).toBe(true);

      // Query entities that follow entity1
      const followers = world.query([followsEntity1]);
      expect(followers).toContain(entity2);
      expect(followers).toContain(entity3);

      // Destroy entity1
      world.destroy(entity1);
      world.sync();

      // Verify entity1 is destroyed
      expect(world.exists(entity1)).toBe(false);

      // Verify relation components are cleaned up
      expect(world.has(entity2, followsEntity1)).toBe(false);
      expect(world.has(entity3, followsEntity1)).toBe(false);

      // Query should now return empty
      const followersAfterDestroy = world.query([followsEntity1]);
      expect(followersAfterDestroy).toHaveLength(0);

      // entity2 and entity3 should still exist but without the relation components
      expect(world.exists(entity2)).toBe(true);
      expect(world.exists(entity3)).toBe(true);
    });

    it("should clean up components when entity is used directly as component type and destroyed", () => {
      const world = new World();

      // Create entities
      const entity1 = world.new(); // This will be used as component type
      const entity2 = world.new(); // This will have entity1 as component

      // Add entity1 directly as a component type to entity2
      world.set(entity2, entity1);
      world.sync();

      // Verify the component exists
      expect(world.has(entity2, entity1)).toBe(true);

      // Query entities that have entity1 as component
      const entitiesWithComponent = world.query([entity1]);
      expect(entitiesWithComponent).toContain(entity2);

      // Destroy entity1
      world.destroy(entity1);
      world.sync();

      // Verify entity1 is destroyed
      expect(world.exists(entity1)).toBe(false);

      // Verify the component is cleaned up
      expect(world.has(entity2, entity1)).toBe(false);

      // Query should now return empty
      const entitiesWithComponentAfterDestroy = world.query([entity1]);
      expect(entitiesWithComponentAfterDestroy).toHaveLength(0);

      // entity2 should still exist
      expect(world.exists(entity2)).toBe(true);
    });
  });

  describe("Component Hooks", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = component<Position>();
    const velocityComponent = component<Velocity>();

    it("should trigger component added hooks", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      let hookCalled = false;
      let hookEntityId: EntityId | undefined;
      let hookComponentType: EntityId<Position> | undefined;
      let hookComponent: Position | undefined;

      world.registerLifecycleHook(positionComponent, {
        onAdded: (entityId, componentType, component) => {
          hookCalled = true;
          hookEntityId = entityId;
          hookComponentType = componentType;
          hookComponent = component;
        },
      });

      world.set(entity, positionComponent, position);
      world.sync();

      expect(hookCalled).toBe(true);
      expect(hookEntityId).toBe(entity);
      expect(hookComponentType).toBe(positionComponent);
      expect(hookComponent).toEqual(position);
    });

    it("should trigger component removed hooks", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      world.set(entity, positionComponent, position);
      world.sync();

      let hookCalled = false;
      let hookEntityId: EntityId | undefined;
      let hookComponentType: EntityId<Position> | undefined;

      world.registerLifecycleHook(positionComponent, {
        onRemoved: (entityId, componentType) => {
          hookCalled = true;
          hookEntityId = entityId;
          hookComponentType = componentType;
        },
      });

      world.delete(entity, positionComponent);
      world.sync();

      expect(hookCalled).toBe(true);
      expect(hookEntityId).toBe(entity);
      expect(hookComponentType).toBe(positionComponent);
    });

    it("should handle multiple hooks for the same component type", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      let hook1Called = false;
      let hook2Called = false;

      world.registerLifecycleHook(positionComponent, {
        onAdded: () => {
          hook1Called = true;
        },
      });

      world.registerLifecycleHook(positionComponent, {
        onAdded: () => {
          hook2Called = true;
        },
      });

      world.set(entity, positionComponent, position);
      world.sync();

      expect(hook1Called).toBe(true);
      expect(hook2Called).toBe(true);
    });

    it("should support hooks with both onAdded and onRemoved", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      let addedCalled = false;
      let removedCalled = false;

      world.registerLifecycleHook(positionComponent, {
        onAdded: () => {
          addedCalled = true;
        },
        onRemoved: () => {
          removedCalled = true;
        },
      });

      world.set(entity, positionComponent, position);
      world.sync();

      expect(addedCalled).toBe(true);
      expect(removedCalled).toBe(false);

      world.delete(entity, positionComponent);
      world.sync();

      expect(removedCalled).toBe(true);
    });

    it("should support hooks with only onAdded", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      let addedCalled = false;

      world.registerLifecycleHook(positionComponent, {
        onAdded: () => {
          addedCalled = true;
        },
      });

      world.set(entity, positionComponent, position);
      world.sync();

      expect(addedCalled).toBe(true);
    });

    it("should support hooks with only onRemoved", () => {
      const world = new World();
      const entity = world.new();
      const position: Position = { x: 10, y: 20 };

      world.set(entity, positionComponent, position);
      world.sync();

      let removedCalled = false;

      world.registerLifecycleHook(positionComponent, {
        onRemoved: () => {
          removedCalled = true;
        },
      });

      world.delete(entity, positionComponent);
      world.sync();

      expect(removedCalled).toBe(true);
    });
  });

  describe("Wildcard Relation Hooks", () => {
    it("should trigger wildcard relation hooks for matching relation components", () => {
      const world = new World();
      const positionComponent = component<{ x: number; y: number }>();
      const entity1 = world.new();
      const entity2 = world.new();

      // Create a relation component (positionComponent -> entity2)
      const relationId = relation(positionComponent, entity2);

      // Create a wildcard relation ID for positionComponent
      const wildcardRelationId = relation(positionComponent, "*");

      let addedCalled = false;
      let removedCalled = false;
      let addedComponentType: EntityId<{ x: number; y: number }> | undefined;
      let removedComponentType: EntityId<{ x: number; y: number }> | undefined;

      // Register a wildcard relation hook for positionComponent
      world.registerLifecycleHook(wildcardRelationId, {
        onAdded: (entityId, componentType, component) => {
          addedCalled = true;
          addedComponentType = componentType;
        },
        onRemoved: (entityId, componentType) => {
          removedCalled = true;
          removedComponentType = componentType;
        },
      });

      // Add the relation component
      world.set(entity1, relationId, { x: 10, y: 20 });
      world.sync();

      expect(addedCalled).toBe(true);
      expect(addedComponentType).toBe(relationId);

      // Remove the relation component
      world.delete(entity1, relationId);
      world.sync();

      expect(removedCalled).toBe(true);
      expect(removedComponentType).toBe(relationId);
    });

    it("should not trigger wildcard relation hooks for non-matching components", () => {
      const world = new World();
      const positionComponent = component<{ x: number; y: number }>();
      const velocityComponent = component<{ vx: number; vy: number }>();
      const entity1 = world.new();
      const entity2 = world.new();

      // Create a wildcard relation ID for positionComponent
      const wildcardRelationId = relation(positionComponent, "*");

      let hookCalled = false;

      // Register a wildcard relation hook for positionComponent
      world.registerLifecycleHook(wildcardRelationId, {
        onAdded: () => {
          hookCalled = true;
        },
      });

      // Add a velocity component (not a position relation)
      world.set(entity1, velocityComponent, { vx: 1, vy: 2 });
      world.sync();

      expect(hookCalled).toBe(false);
    });
  });
});
