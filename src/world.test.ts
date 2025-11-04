import { describe, expect, it } from "bun:test";
import { createComponentId, createEntityId, createRelationId, type EntityId } from "./entity";
import { World } from "./world";

describe("World", () => {
  describe("Entity Management", () => {
    it("should create entities", () => {
      const world = new World();
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();

      expect(world.hasEntity(entity1)).toBe(true);
      expect(world.hasEntity(entity2)).toBe(true);
      expect(entity1).not.toBe(entity2);
    });

    it("should destroy entities", () => {
      const world = new World();
      const entity = world.createEntity();
      expect(world.hasEntity(entity)).toBe(true);

      world.destroyEntity(entity);
      world.flushCommands();
      expect(world.hasEntity(entity)).toBe(false);
    });

    it("should handle destroying non-existent entities gracefully", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);
      expect(world.hasEntity(fakeEntity)).toBe(false);
      // Should not throw
      world.destroyEntity(fakeEntity);
    });
  });

  describe("Component Management", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = createComponentId<Position>(1);
    const velocityComponent = createComponentId<Velocity>(2);

    it("should add components to entities", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      world.addComponent(entity, positionComponent, position);
      world.flushCommands(); // Execute deferred commands

      expect(world.hasComponent(entity, positionComponent)).toBe(true);
      expect(world.getComponent(entity, positionComponent)).toEqual(position);
    });

    it("should update existing components", () => {
      const world = new World();
      const entity = world.createEntity();
      const position1: Position = { x: 10, y: 20 };
      const position2: Position = { x: 30, y: 40 };

      world.addComponent(entity, positionComponent, position1);
      world.flushCommands();
      expect(world.getComponent(entity, positionComponent)).toEqual(position1);

      world.addComponent(entity, positionComponent, position2);
      world.flushCommands();
      expect(world.getComponent(entity, positionComponent)).toEqual(position2);
    });

    it("should remove components from entities", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();
      expect(world.hasComponent(entity, positionComponent)).toBe(true);

      world.removeComponent(entity, positionComponent);
      world.flushCommands();
      expect(world.hasComponent(entity, positionComponent)).toBe(false);
      expect(world.getComponent(entity, positionComponent)).toBeUndefined();
    });

    it("should handle multiple components", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };
      const velocity: Velocity = { x: 1, y: 2 };

      world.addComponent(entity, positionComponent, position);
      world.addComponent(entity, velocityComponent, velocity);
      world.flushCommands();

      expect(world.hasComponent(entity, positionComponent)).toBe(true);
      expect(world.hasComponent(entity, velocityComponent)).toBe(true);
      expect(world.getComponent(entity, positionComponent)).toEqual(position);
      expect(world.getComponent(entity, velocityComponent)).toEqual(velocity);
    });

    it("should throw error when adding component to non-existent entity", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);
      const position: Position = { x: 10, y: 20 };

      expect(() => world.addComponent(fakeEntity, positionComponent, position)).toThrow("Entity 9999 does not exist");
    });

    it("should throw error when getting component from non-existent entity", () => {
      const world = new World();
      const fakeEntity = createEntityId(9999);

      expect(world.getComponent(fakeEntity, positionComponent)).toBeUndefined();
    });
  });

  describe("System Management", () => {
    it("should register and unregister systems", () => {
      const world = new World();
      const system = { update: () => {} };

      world.registerSystem(system);
      // Update should not throw
      world.update(0.016);

      world.unregisterSystem(system);
      // Update should still not throw
      world.update(0.016);
    });

    it("should call system update methods", () => {
      const world = new World();
      let updateCalled = false;
      const system = {
        update: (w: World, dt: number) => {
          updateCalled = true;
          expect(w).toBe(world);
          expect(dt).toBe(0.016);
        },
      };

      world.registerSystem(system);
      world.update(0.016);

      expect(updateCalled).toBe(true);
    });
  });

  describe("Query", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = createComponentId<Position>(1);
    const velocityComponent = createComponentId<Velocity>(2);

    it("should query entities with specific components", () => {
      const world = new World();
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();
      const entity3 = world.createEntity();

      world.addComponent(entity1, positionComponent, { x: 1, y: 2 });
      world.addComponent(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.addComponent(entity2, positionComponent, { x: 3, y: 4 });

      // entity3 has no components

      world.flushCommands(); // Execute deferred commands

      const positionEntities = world.queryEntities([positionComponent]);
      expect(positionEntities).toContain(entity1);
      expect(positionEntities).toContain(entity2);
      expect(positionEntities).not.toContain(entity3);

      const velocityEntities = world.queryEntities([velocityComponent]);
      expect(velocityEntities).toContain(entity1);
      expect(velocityEntities).not.toContain(entity2);
      expect(velocityEntities).not.toContain(entity3);

      const bothEntities = world.queryEntities([positionComponent, velocityComponent]);
      expect(bothEntities).toContain(entity1);
      expect(bothEntities).not.toContain(entity2);
      expect(bothEntities).not.toContain(entity3);
    });

    it("should return empty array for queries with no matches", () => {
      const world = new World();
      const entity = world.createEntity();
      world.addComponent(entity, positionComponent, { x: 1, y: 2 });

      const result = world.queryEntities([velocityComponent]);
      expect(result).toEqual([]);
    });

    it("should query entities with wildcard relations", () => {
      const world = new World();
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();
      const entity3 = world.createEntity();

      // Create a wildcard relation for position component
      const wildcardPositionRelation = createRelationId(positionComponent, "*");

      world.addComponent(entity1, positionComponent, { x: 1, y: 2 });
      world.addComponent(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.addComponent(entity2, positionComponent, { x: 3, y: 4 });

      // entity3 has no position component

      world.flushCommands(); // Execute deferred commands

      // Query with wildcard relation should find all entities with position component
      const wildcardEntities = world.queryEntities([wildcardPositionRelation]);
      expect(wildcardEntities).toContain(entity1);
      expect(wildcardEntities).toContain(entity2);
      expect(wildcardEntities).not.toContain(entity3);
    });

    it("should query entities with mixed component and wildcard relation queries", () => {
      const world = new World();
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();
      const entity3 = world.createEntity();

      // Create a wildcard relation for position component
      const wildcardPositionRelation = createRelationId(positionComponent, "*");

      world.addComponent(entity1, positionComponent, { x: 1, y: 2 });
      world.addComponent(entity1, velocityComponent, { x: 0.1, y: 0.2 });

      world.addComponent(entity2, positionComponent, { x: 3, y: 4 });
      // entity2 doesn't have velocity

      world.addComponent(entity3, velocityComponent, { x: 0.5, y: 0.6 });
      // entity3 doesn't have position

      world.flushCommands(); // Execute deferred commands

      // Query with both velocity component and wildcard position relation
      // Should only match entity1 (has both position and velocity)
      const mixedEntities = world.queryEntities([velocityComponent, wildcardPositionRelation]);
      expect(mixedEntities).toContain(entity1);
      expect(mixedEntities).not.toContain(entity2);
      expect(mixedEntities).not.toContain(entity3);
    });

    it("should clean up relation components when target entity is destroyed", () => {
      const world = new World();

      // Create component IDs
      const positionComponent = createComponentId<{ x: number; y: number }>(1);
      const followsComponent = createComponentId<void>(2);

      // Create entities
      const entity1 = world.createEntity(); // This will be followed
      const entity2 = world.createEntity(); // This will follow entity1
      const entity3 = world.createEntity(); // This will also follow entity1

      // Add position to entity1
      world.addComponent(entity1, positionComponent, { x: 10, y: 20 });
      world.flushCommands();

      // Create relation components (entity2 and entity3 follow entity1)
      const followsEntity1 = createRelationId(followsComponent, entity1);
      world.addComponent(entity2, followsEntity1, null);
      world.addComponent(entity3, followsEntity1, null);
      world.flushCommands();

      // Verify relations exist
      expect(world.hasComponent(entity2, followsEntity1)).toBe(true);
      expect(world.hasComponent(entity3, followsEntity1)).toBe(true);

      // Query entities that follow entity1
      const followers = world.queryEntities([followsEntity1]);
      expect(followers).toContain(entity2);
      expect(followers).toContain(entity3);

      // Destroy entity1
      world.destroyEntity(entity1);
      world.flushCommands();

      // Verify entity1 is destroyed
      expect(world.hasEntity(entity1)).toBe(false);

      // Verify relation components are cleaned up
      expect(world.hasComponent(entity2, followsEntity1)).toBe(false);
      expect(world.hasComponent(entity3, followsEntity1)).toBe(false);

      // Query should now return empty
      const followersAfterDestroy = world.queryEntities([followsEntity1]);
      expect(followersAfterDestroy).toHaveLength(0);

      // entity2 and entity3 should still exist but without the relation components
      expect(world.hasEntity(entity2)).toBe(true);
      expect(world.hasEntity(entity3)).toBe(true);
    });

    it("should clean up components when entity is used directly as component type and destroyed", () => {
      const world = new World();

      // Create entities
      const entity1 = world.createEntity(); // This will be used as component type
      const entity2 = world.createEntity(); // This will have entity1 as component

      // Add entity1 directly as a component type to entity2
      world.addComponent(entity2, entity1, null);
      world.flushCommands();

      // Verify the component exists
      expect(world.hasComponent(entity2, entity1)).toBe(true);

      // Query entities that have entity1 as component
      const entitiesWithComponent = world.queryEntities([entity1]);
      expect(entitiesWithComponent).toContain(entity2);

      // Destroy entity1
      world.destroyEntity(entity1);
      world.flushCommands();

      // Verify entity1 is destroyed
      expect(world.hasEntity(entity1)).toBe(false);

      // Verify the component is cleaned up
      expect(world.hasComponent(entity2, entity1)).toBe(false);

      // Query should now return empty
      const entitiesWithComponentAfterDestroy = world.queryEntities([entity1]);
      expect(entitiesWithComponentAfterDestroy).toHaveLength(0);

            // entity2 should still exist
      expect(world.hasEntity(entity2)).toBe(true);
    });
  });

  describe("Component Hooks", () => {
    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const positionComponent = createComponentId<Position>(1);
    const velocityComponent = createComponentId<Velocity>(2);

    it("should trigger component added hooks", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      let hookCalled = false;
      let hookEntityId: EntityId | undefined;
      let hookComponentType: EntityId<Position> | undefined;
      let hookComponent: Position | undefined;

      world.registerComponentLifecycleHook(positionComponent, {
        onAdded: (entityId, componentType, component) => {
          hookCalled = true;
          hookEntityId = entityId;
          hookComponentType = componentType;
          hookComponent = component;
        }
      });

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      expect(hookCalled).toBe(true);
      expect(hookEntityId).toBe(entity);
      expect(hookComponentType).toBe(positionComponent);
      expect(hookComponent).toEqual(position);
    });

    it("should trigger component removed hooks", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      let hookCalled = false;
      let hookEntityId: EntityId | undefined;
      let hookComponentType: EntityId<Position> | undefined;

      world.registerComponentLifecycleHook(positionComponent, {
        onRemoved: (entityId, componentType) => {
          hookCalled = true;
          hookEntityId = entityId;
          hookComponentType = componentType;
        }
      });

      world.removeComponent(entity, positionComponent);
      world.flushCommands();

      expect(hookCalled).toBe(true);
      expect(hookEntityId).toBe(entity);
      expect(hookComponentType).toBe(positionComponent);
    });

    it("should handle multiple hooks for the same component type", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      let hook1Called = false;
      let hook2Called = false;

      world.registerComponentLifecycleHook(positionComponent, {
        onAdded: () => {
          hook1Called = true;
        }
      });

      world.registerComponentLifecycleHook(positionComponent, {
        onAdded: () => {
          hook2Called = true;
        }
      });

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      expect(hook1Called).toBe(true);
      expect(hook2Called).toBe(true);
    });

    it("should support hooks with both onAdded and onRemoved", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      let addedCalled = false;
      let removedCalled = false;

      world.registerComponentLifecycleHook(positionComponent, {
        onAdded: () => {
          addedCalled = true;
        },
        onRemoved: () => {
          removedCalled = true;
        }
      });

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      expect(addedCalled).toBe(true);
      expect(removedCalled).toBe(false);

      world.removeComponent(entity, positionComponent);
      world.flushCommands();

      expect(removedCalled).toBe(true);
    });

    it("should support hooks with only onAdded", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      let addedCalled = false;

      world.registerComponentLifecycleHook(positionComponent, {
        onAdded: () => {
          addedCalled = true;
        }
      });

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      expect(addedCalled).toBe(true);
    });

    it("should support hooks with only onRemoved", () => {
      const world = new World();
      const entity = world.createEntity();
      const position: Position = { x: 10, y: 20 };

      world.addComponent(entity, positionComponent, position);
      world.flushCommands();

      let removedCalled = false;

      world.registerComponentLifecycleHook(positionComponent, {
        onRemoved: () => {
          removedCalled = true;
        }
      });

      world.removeComponent(entity, positionComponent);
      world.flushCommands();

      expect(removedCalled).toBe(true);
    });
  });

  describe("Wildcard Relation Hooks", () => {
    it("should trigger wildcard relation hooks for matching relation components", () => {
      const world = new World();
      const positionComponent = createComponentId<{ x: number; y: number }>(1);
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();

      // Create a relation component (positionComponent -> entity2)
      const relationId = createRelationId(positionComponent, entity2);

      let addedCalled = false;
      let removedCalled = false;
      let addedComponentType: EntityId<{ x: number; y: number }> | undefined;
      let removedComponentType: EntityId<{ x: number; y: number }> | undefined;

      // Register a wildcard relation hook for positionComponent
      world.registerWildcardRelationLifecycleHook(positionComponent, {
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
      world.addComponent(entity1, relationId, { x: 10, y: 20 });
      world.flushCommands();

      expect(addedCalled).toBe(true);
      expect(addedComponentType).toBe(relationId);

      // Remove the relation component
      world.removeComponent(entity1, relationId);
      world.flushCommands();

      expect(removedCalled).toBe(true);
      expect(removedComponentType).toBe(relationId);
    });

    it("should not trigger wildcard relation hooks for non-matching components", () => {
      const world = new World();
      const positionComponent = createComponentId<{ x: number; y: number }>(1);
      const velocityComponent = createComponentId<{ vx: number; vy: number }>(2);
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();

      let hookCalled = false;

      // Register a wildcard relation hook for positionComponent
      world.registerWildcardRelationLifecycleHook(positionComponent, {
        onAdded: () => {
          hookCalled = true;
        },
      });

      // Add a velocity component (not a position relation)
      world.addComponent(entity1, velocityComponent, { vx: 1, vy: 2 });
      world.flushCommands();

      expect(hookCalled).toBe(false);
    });
  });
});
