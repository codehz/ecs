import { describe, expect, it } from "bun:test";
import { component, relation, type EntityId } from "../core/entity";
import { World } from "../core/world";

describe("World - Multi-Component Hooks", () => {
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

    world.hook([A, B], hook);

    const entity1 = world.spawn().with(A, 1).with(B, "first").build();
    world.sync();

    expect(calls.length).toBe(1);

    world.unhook([A, B], hook);

    const entity2 = world.spawn().with(A, 2).with(B, "second").build();
    world.sync();

    expect(calls.length).toBe(1);
    expect(world.has(entity1, A)).toBe(true);
    expect(world.has(entity2, A)).toBe(true);
  });

  describe("Wildcard-Relation Support", () => {
    it("should trigger on_set when wildcard relation matches added relation component", () => {
      const world = new World();
      const A = component<number>();
      const RelData = component<{ value: string }>();
      const target = world.new();
      const wildcardRel = relation(RelData, "*");
      const concreteRel = relation(RelData, target);

      const calls: { entityId: EntityId; components: readonly [number, [EntityId, { value: string }][]] }[] = [];

      world.hook([A, wildcardRel], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      // Create entity with both A and a concrete relation
      const entity = world.spawn().with(A, 42).with(concreteRel, { value: "hello" }).build();
      world.sync();

      expect(calls.length).toBe(1);
      expect(calls[0]!.entityId).toBe(entity);
      expect(calls[0]!.components[0]).toBe(42);
      expect(calls[0]!.components[1]).toEqual([[target, { value: "hello" }]]);
    });

    it("should trigger on_set when adding a new relation that matches wildcard", () => {
      const world = new World();
      const A = component<number>();
      const RelData = component<{ value: string }>();
      const target1 = world.new();
      const target2 = world.new();
      const wildcardRel = relation(RelData, "*");

      const calls: { entityId: EntityId; components: readonly [number, [EntityId, { value: string }][]] }[] = [];

      world.hook([A, wildcardRel], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      // First, create entity with A and one relation
      const entity = world.spawn().with(A, 42).with(relation(RelData, target1), { value: "first" }).build();
      world.sync();

      expect(calls.length).toBe(1);

      // Add another relation - should trigger again
      world.set(entity, relation(RelData, target2), { value: "second" });
      world.sync();

      expect(calls.length).toBe(2);
      // Check that both relations are present (order may vary)
      const relations = calls[1]!.components[1] as [EntityId, { value: string }][];
      expect(relations.length).toBe(2);
      expect(relations).toContainEqual([target1, { value: "first" }]);
      expect(relations).toContainEqual([target2, { value: "second" }]);
    });

    it("should not trigger on_set when wildcard relation requirement not met", () => {
      const world = new World();
      const A = component<number>();
      const RelData = component<{ value: string }>();
      const wildcardRel = relation(RelData, "*");

      const calls: any[] = [];

      world.hook([A, wildcardRel], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      // Create entity with only A, no relation
      const entity = world.spawn().with(A, 42).build();
      world.sync();

      expect(calls.length).toBe(0);
      expect(world.has(entity, A)).toBe(true);
    });

    it("should trigger on_remove when wildcard relation matches removed relation component", () => {
      const world = new World();
      const A = component<number>();
      const RelData = component<{ value: string }>();
      const target = world.new();
      const wildcardRel = relation(RelData, "*");
      const concreteRel = relation(RelData, target);

      const removeCalls: { entityId: EntityId; components: any }[] = [];

      world.hook([A, wildcardRel], {
        on_remove: (entityId, ...components) => {
          removeCalls.push({ entityId, components });
        },
      });

      const entity = world.spawn().with(A, 42).with(concreteRel, { value: "hello" }).build();
      world.sync();

      // Remove the relation
      world.remove(entity, concreteRel);
      world.sync();

      expect(removeCalls.length).toBe(1);
      expect(removeCalls[0]!.entityId).toBe(entity);
    });

    it("should support optional wildcard relation in multi-hook", () => {
      const world = new World();
      const A = component<number>();
      const RelData = component<{ value: string }>();
      const target = world.new();
      const wildcardRel = relation(RelData, "*");
      const concreteRel = relation(RelData, target);

      const calls: { entityId: EntityId; components: any }[] = [];

      world.hook([A, { optional: wildcardRel }], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      // Create entity with only A
      const entity = world.spawn().with(A, 42).build();
      world.sync();

      expect(calls.length).toBe(1);
      expect(calls[0]!.components).toEqual([42, undefined]);

      // Add a relation
      world.set(entity, concreteRel, { value: "hello" });
      world.sync();

      expect(calls.length).toBe(2);
      expect(calls[1]!.components[0]).toBe(42);
      expect(calls[1]!.components[1]).toEqual({ value: [[target, { value: "hello" }]] });
    });

    it("should trigger on_set with multiple wildcard relations", () => {
      const world = new World();
      const A = component<number>();
      const RelData1 = component<{ x: number }>();
      const RelData2 = component<{ y: number }>();
      const target1 = world.new();
      const target2 = world.new();
      const wildcardRel1 = relation(RelData1, "*");
      const wildcardRel2 = relation(RelData2, "*");

      const calls: { entityId: EntityId; components: any }[] = [];

      world.hook([A, wildcardRel1, wildcardRel2], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      const entity = world
        .spawn()
        .with(A, 42)
        .with(relation(RelData1, target1), { x: 10 })
        .with(relation(RelData2, target2), { y: 20 })
        .build();
      world.sync();

      expect(calls.length).toBe(1);
      expect(calls[0]!.entityId).toBe(entity);
      expect(calls[0]!.components[0]).toBe(42);
      expect(calls[0]!.components[1]).toEqual([[target1, { x: 10 }]]);
      expect(calls[0]!.components[2]).toEqual([[target2, { y: 20 }]]);
    });

    it("should not match unrelated relation components with wildcard", () => {
      const world = new World();
      const A = component<number>();
      const RelData1 = component<{ x: number }>();
      const RelData2 = component<{ y: number }>();
      const target = world.new();
      const wildcardRel1 = relation(RelData1, "*");

      const calls: any[] = [];

      world.hook([A, wildcardRel1], {
        on_set: (entityId, ...components) => {
          calls.push({ entityId, components });
        },
      });

      // Create entity with A and a different relation type
      const entity = world.spawn().with(A, 42).with(relation(RelData2, target), { y: 20 }).build();
      world.sync();

      // Should not trigger because RelData2 doesn't match RelData1's wildcard
      expect(calls.length).toBe(0);
      expect(world.has(entity, A)).toBe(true);
    });

    it("should trigger on_set when only wildcard relation specified as single required component", () => {
      const world = new World();
      const RelData = component<{ value: string }>();
      const target1 = world.new();
      const target2 = world.new();
      const wildcardRel = relation(RelData, "*");

      const setCalls: { entityId: EntityId; relations: [EntityId, { value: string }][] }[] = [];

      world.hook([wildcardRel], {
        on_set: (entityId, relations) => {
          setCalls.push({ entityId, relations });
        },
      });

      // Create entity with a matching relation
      const entity = world.spawn().with(relation(RelData, target1), { value: "first" }).build();
      world.sync();

      expect(setCalls.length).toBe(1);
      expect(setCalls[0]!.entityId).toBe(entity);
      expect(setCalls[0]!.relations).toEqual([[target1, { value: "first" }]]);

      // Add another matching relation - should trigger again
      world.set(entity, relation(RelData, target2), { value: "second" });
      world.sync();

      expect(setCalls.length).toBe(2);
      expect(setCalls[1]!.entityId).toBe(entity);
      const relations = setCalls[1]!.relations;
      expect(relations.length).toBe(2);
      expect(relations).toContainEqual([target1, { value: "first" }]);
      expect(relations).toContainEqual([target2, { value: "second" }]);
    });

    it("should trigger on_remove when only wildcard relation specified and last relation removed", () => {
      const world = new World();
      const RelData = component<{ value: string }>();
      const target1 = world.new();
      const target2 = world.new();
      const wildcardRel = relation(RelData, "*");

      const removeCalls: { entityId: EntityId; relations: [EntityId, { value: string }][] }[] = [];

      world.hook([wildcardRel], {
        on_remove: (entityId, relations) => {
          removeCalls.push({ entityId, relations });
        },
      });

      // Create entity with two matching relations
      const entity = world
        .spawn()
        .with(relation(RelData, target1), { value: "first" })
        .with(relation(RelData, target2), { value: "second" })
        .build();
      world.sync();

      // Remove one relation - should NOT trigger on_remove (still has other matching relations)
      world.remove(entity, relation(RelData, target1));
      world.sync();

      expect(removeCalls.length).toBe(0);
      expect(world.has(entity, relation(RelData, target2))).toBe(true);

      // Remove the last matching relation - should trigger on_remove now
      world.remove(entity, relation(RelData, target2));
      world.sync();

      expect(removeCalls.length).toBe(1);
      expect(removeCalls[0]!.entityId).toBe(entity);
      // The callback receives array format with the removed relation
      expect(removeCalls[0]!.relations).toEqual([[target2, { value: "second" }]]);
    });

    it("should trigger on_init when only wildcard relation specified for existing matching entities", () => {
      const world = new World();
      const RelData = component<{ value: string }>();
      const target = world.new();
      const wildcardRel = relation(RelData, "*");

      // Create entity with a matching relation before hook
      const entity = world.spawn().with(relation(RelData, target), { value: "existing" }).build();
      world.sync();

      const initCalls: { entityId: EntityId; relations: [EntityId, { value: string }][] }[] = [];

      // Register hook - should trigger on_init for existing entity
      world.hook([wildcardRel], {
        on_init: (entityId, relations) => {
          initCalls.push({ entityId, relations });
        },
      });

      expect(initCalls.length).toBe(1);
      expect(initCalls[0]!.entityId).toBe(entity);
      expect(initCalls[0]!.relations).toEqual([[target, { value: "existing" }]]);
    });

    it("should not trigger when only wildcard relation specified and entity has no matching relations", () => {
      const world = new World();
      const RelData = component<{ value: string }>();
      const OtherData = component<{ other: number }>();
      const target = world.new();
      const wildcardRel = relation(RelData, "*");

      const setCalls: any[] = [];

      world.hook([wildcardRel], {
        on_set: (entityId, relations) => {
          setCalls.push({ entityId, relations });
        },
      });

      // Create entity with no relations
      const entity1 = world.spawn().build();
      world.sync();

      // Create entity with a different relation type
      const entity2 = world.spawn().with(relation(OtherData, target), { other: 42 }).build();
      world.sync();

      // Neither should trigger the hook
      expect(setCalls.length).toBe(0);
      expect(world.exists(entity1)).toBe(true);
      expect(world.exists(entity2)).toBe(true);
    });
  });
});
