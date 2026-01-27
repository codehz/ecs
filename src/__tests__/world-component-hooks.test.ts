import { describe, expect, it } from "bun:test";
import { component, type EntityId } from "../core/entity";
import { World } from "../core/world";

describe("World - Component Hooks", () => {
  type Position = { x: number; y: number };

  const positionComponent = component<Position>();

  it("should trigger component initialized hooks", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    let hookCalled = false;
    let hookEntityId: EntityId | undefined;

    let hookComponentType: EntityId<Position> | undefined;
    let hookComponent: Position | undefined;

    world.set(entity, positionComponent, position);
    world.sync();

    world.hook(positionComponent, {
      on_init: (entityId, componentType, component) => {
        hookCalled = true;
        hookEntityId = entityId;
        hookComponentType = componentType;
        hookComponent = component;
      },
    });

    expect(hookCalled).toBe(true);
    expect(hookEntityId).toBe(entity);
    expect(hookComponentType).toBe(positionComponent);
    expect(hookComponent).toEqual(position);
  });

  it("should trigger component added hooks", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    let hookCalled = false;
    let hookEntityId: EntityId | undefined;
    let hookComponentType: EntityId<Position> | undefined;
    let hookComponent: Position | undefined;

    world.hook(positionComponent, {
      on_set: (entityId, componentType, component) => {
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
    let hookComponent: Position | undefined;

    world.hook(positionComponent, {
      on_remove: (entityId, componentType, component) => {
        hookCalled = true;
        hookEntityId = entityId;
        hookComponentType = componentType;
        hookComponent = component;
      },
    });

    world.remove(entity, positionComponent);
    world.sync();

    expect(hookCalled).toBe(true);
    expect(hookEntityId).toBe(entity);
    expect(hookComponentType).toBe(positionComponent);
    expect(hookComponent).toEqual(position);
  });

  it("should handle multiple hooks for the same component type", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    let hook1Called = false;
    let hook2Called = false;

    world.hook(positionComponent, {
      on_set: () => {
        hook1Called = true;
      },
    });

    world.hook(positionComponent, {
      on_set: () => {
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

    world.hook(positionComponent, {
      on_set: () => {
        addedCalled = true;
      },
      on_remove: () => {
        removedCalled = true;
      },
    });

    world.set(entity, positionComponent, position);
    world.sync();

    expect(addedCalled).toBe(true);
    expect(removedCalled).toBe(false);

    world.remove(entity, positionComponent);
    world.sync();

    expect(removedCalled).toBe(true);
  });

  it("should support hooks with only onAdded", () => {
    const world = new World();
    const entity = world.new();
    const position: Position = { x: 10, y: 20 };

    let addedCalled = false;

    world.hook(positionComponent, {
      on_set: () => {
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

    world.hook(positionComponent, {
      on_remove: () => {
        removedCalled = true;
      },
    });

    world.remove(entity, positionComponent);
    world.sync();

    expect(removedCalled).toBe(true);
  });
});
