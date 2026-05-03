import { describe, expect, it } from "bun:test";
import { component, type EntityId } from "../../entity";
import { World } from "../../world/world";

describe("World - Multi-Component Hooks", () => {
  it("should trigger init, set, remove events correctly when using array syntax with single element", () => {
    const world = new World();
    const A = component<number>();

    const initCalls: { entityId: EntityId; value: number }[] = [];
    const setCalls: { entityId: EntityId; value: number }[] = [];
    const removeCalls: { entityId: EntityId; value: number }[] = [];

    // First create an entity before registering the hook (for on_init test)
    const existingEntity = world.spawn().with(A, 100).build();
    world.sync();

    // Register hook using array syntax with single element
    world.hook([A], {
      on_init: (entityId, value) => {
        initCalls.push({ entityId, value });
      },
      on_set: (entityId, value) => {
        setCalls.push({ entityId, value });
      },
      on_remove: (entityId, value) => {
        removeCalls.push({ entityId, value });
      },
    });

    // on_init should be triggered for existing entity
    expect(initCalls.length).toBe(1);
    expect(initCalls[0]!.entityId).toBe(existingEntity);
    expect(initCalls[0]!.value).toBe(100);

    // Create a new entity - should trigger on_set
    const newEntity = world.spawn().with(A, 42).build();
    world.sync();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]!.entityId).toBe(newEntity);
    expect(setCalls[0]!.value).toBe(42);

    // Update the component - should trigger on_set again
    world.set(newEntity, A, 99);
    world.sync();

    expect(setCalls.length).toBe(2);
    expect(setCalls[1]!.entityId).toBe(newEntity);
    expect(setCalls[1]!.value).toBe(99);

    // Remove the component - should trigger on_remove
    world.remove(newEntity, A);
    world.sync();

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.entityId).toBe(newEntity);
    expect(removeCalls[0]!.value).toBe(99);

    // Delete the existing entity - should trigger on_remove
    world.delete(existingEntity);
    world.sync();

    expect(removeCalls.length).toBe(2);
    expect(removeCalls[1]!.entityId).toBe(existingEntity);
    expect(removeCalls[1]!.value).toBe(100);
  });

  it("should throw error when hook has no required components (only optional)", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();

    expect(() => {
      world.hook([{ optional: A }, { optional: B }], {
        on_set: () => {},
      });
    }).toThrow();
  });

  it("should throw error when hook has empty component array", () => {
    const world = new World();

    expect(() => {
      world.hook([], {
        on_set: () => {},
      });
    }).toThrow();
  });

  it("should trigger on_set when all required components are present", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: { entityId: EntityId; components: readonly [number, string] }[] = [];

    world.hook([A, B], {
      on_set: (entityId, ...components) => {
        calls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(calls[0]!.entityId).toBe(entity);
    expect(calls[0]!.components).toEqual([42, "hello"]);
  });

  it("should not trigger on_set when some required components are missing", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: any[] = [];

    world.hook([A, B], {
      on_set: (entityId, ...components) => {
        calls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).build();
    world.sync();

    expect(calls.length).toBe(0);
    expect(world.has(entity, A)).toBe(true);
    expect(world.has(entity, B)).toBe(false);
  });

  it("should trigger on_set with optional component present", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_set: (entityId, ...components) => {
        calls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(calls[0]!.entityId).toBe(entity);
    expect(calls[0]!.components).toEqual([42, { value: "hello" }]);
  });

  it("should trigger on_set with optional component absent", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_set: (entityId, ...components) => {
        calls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(calls[0]!.entityId).toBe(entity);
    expect(calls[0]!.components).toEqual([42, undefined]);
  });

  it("should trigger on_set when optional component changes while required component unchanged", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_set: (entityId, ...components) => {
        calls.push({ entityId, components });
      },
    });

    // First, create entity with only A
    const entity = world.spawn().with(A, 42).build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(calls[0]!.components).toEqual([42, undefined]);

    // Now add B - should trigger on_set
    world.set(entity, B, "hello");
    world.sync();

    expect(calls.length).toBe(2);
    expect(calls[1]!.entityId).toBe(entity);
    expect(calls[1]!.components).toEqual([42, { value: "hello" }]);

    // Update B - should also trigger on_set
    world.set(entity, B, "world");
    world.sync();

    expect(calls.length).toBe(3);
    expect(calls[2]!.entityId).toBe(entity);
    expect(calls[2]!.components).toEqual([42, { value: "world" }]);

    // Updating A should also trigger on_set with latest B value
    world.set(entity, A, 100);
    world.sync();

    expect(calls.length).toBe(4);
    expect(calls[3]!.entityId).toBe(entity);
    expect(calls[3]!.components).toEqual([100, { value: "world" }]);
  });

  it("should trigger on_remove when required component is removed with optional present", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const removeCalls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_remove: (entityId, ...components) => {
        removeCalls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    // Remove required component A
    world.remove(entity, A);
    world.sync();

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.entityId).toBe(entity);
    expect(removeCalls[0]!.components).toEqual([42, { value: "hello" }]);
  });

  it("should trigger on_remove when required component is removed with optional absent", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const removeCalls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_remove: (entityId, ...components) => {
        removeCalls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).build();
    world.sync();

    // Remove required component A
    world.remove(entity, A);
    world.sync();

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.entityId).toBe(entity);
    expect(removeCalls[0]!.components).toEqual([42, undefined]);
  });

  it("should not trigger on_remove when optional component is removed", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const removeCalls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_remove: (entityId, ...components) => {
        removeCalls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    // Remove optional component B - should NOT trigger on_remove
    world.remove(entity, B);
    world.sync();

    expect(removeCalls.length).toBe(0);
  });

  it("should trigger on_set when optional component is removed", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const setCalls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook([A, { optional: B }], {
      on_set: (entityId, ...components) => {
        setCalls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]!.components).toEqual([42, { value: "hello" }]);

    // Remove optional component B - should trigger on_set with undefined for B
    world.remove(entity, B);
    world.sync();

    expect(setCalls.length).toBe(2);
    expect(setCalls[1]!.entityId).toBe(entity);
    expect(setCalls[1]!.components).toEqual([42, undefined]);
  });

  it("should trigger on_remove with complete snapshot when required component is removed", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const removeCalls: { entityId: EntityId; components: readonly [number, string] }[] = [];

    world.hook([A, B], {
      on_remove: (entityId, ...components) => {
        removeCalls.push({ entityId, components });
      },
    });

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    world.remove(entity, A);
    world.sync();

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.entityId).toBe(entity);
    expect(removeCalls[0]!.components).toEqual([42, "hello"]);
  });

  it("should trigger on_init for existing entities matching all required components", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();

    const entity = world.spawn().with(A, 42).with(B, "hello").build();
    world.sync();

    const initCalls: { entityId: EntityId; components: readonly [number, string] }[] = [];

    world.hook([A, B], {
      on_init: (entityId, ...components) => {
        initCalls.push({ entityId, components });
      },
    });

    expect(initCalls.length).toBe(1);
    expect(initCalls[0]!.entityId).toBe(entity);
    expect(initCalls[0]!.components).toEqual([42, "hello"]);
  });

  it("should apply negative filter for on_init replay", () => {
    const world = new World();
    const A = component<number>();
    const Disabled = component<void>();

    const activeEntity = world.spawn().with(A, 1).build();
    const filteredEntity = world.spawn().with(A, 2).with(Disabled).build();
    world.sync();

    const initCalls: EntityId[] = [];
    world.hook(
      [A],
      {
        on_init: (entityId) => {
          initCalls.push(entityId);
        },
      },
      { negativeComponentTypes: [Disabled] },
    );

    expect(initCalls).toContain(activeEntity);
    expect(initCalls).not.toContain(filteredEntity);
    expect(initCalls.length).toBe(1);
  });

  it("should trigger on_remove when entering negative filter state", () => {
    const world = new World();
    const A = component<number>();
    const Disabled = component<void>();
    const removeCalls: { entityId: EntityId; value: number }[] = [];

    world.hook(
      [A],
      {
        on_remove: (entityId, value) => {
          removeCalls.push({ entityId, value });
        },
      },
      { negativeComponentTypes: [Disabled] },
    );

    const entity = world.spawn().with(A, 42).build();
    world.sync();
    expect(removeCalls.length).toBe(0);

    world.set(entity, Disabled);
    world.sync();

    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]!.entityId).toBe(entity);
    expect(removeCalls[0]!.value).toBe(42);
  });

  it("should trigger on_set when leaving negative filter state", () => {
    const world = new World();
    const A = component<number>();
    const Disabled = component<void>();
    const setCalls: { entityId: EntityId; value: number }[] = [];

    world.hook(
      [A],
      {
        on_set: (entityId, value) => {
          setCalls.push({ entityId, value });
        },
      },
      { negativeComponentTypes: [Disabled] },
    );

    const entity = world.spawn().with(A, 7).with(Disabled).build();
    world.sync();
    expect(setCalls.length).toBe(0);

    world.remove(entity, Disabled);
    world.sync();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]!.entityId).toBe(entity);
    expect(setCalls[0]!.value).toBe(7);
  });

  it("should suppress normal set events while filtered until re-entering", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const Disabled = component<void>();
    const setCalls: { entityId: EntityId; components: readonly [number, { value: string } | undefined] }[] = [];

    world.hook(
      [A, { optional: B }],
      {
        on_set: (entityId, ...components) => {
          setCalls.push({ entityId, components });
        },
      },
      { negativeComponentTypes: [Disabled] },
    );

    const entity = world.spawn().with(A, 1).with(Disabled).build();
    world.sync();
    expect(setCalls.length).toBe(0);

    world.set(entity, B, "blocked");
    world.sync();
    expect(setCalls.length).toBe(0);

    world.set(entity, A, 2);
    world.sync();
    expect(setCalls.length).toBe(0);

    world.remove(entity, Disabled);
    world.sync();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]!.entityId).toBe(entity);
    expect(setCalls[0]!.components).toEqual([2, { value: "blocked" }]);
  });

  it("should stop triggering after unhook for multi-component hooks", () => {
    const world = new World();
    const A = component<number>();
    const B = component<string>();
    const calls: any[] = [];

    const hook = {
      on_set: (entityId: EntityId, ...components: any[]) => {
        calls.push({ entityId, components });
      },
    };

    const unhook = world.hook([A, B], hook);

    const entity1 = world.spawn().with(A, 1).with(B, "first").build();
    world.sync();

    expect(calls.length).toBe(1);

    unhook();

    const entity2 = world.spawn().with(A, 2).with(B, "second").build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(world.has(entity1, A)).toBe(true);
    expect(world.has(entity2, A)).toBe(true);
  });
});
