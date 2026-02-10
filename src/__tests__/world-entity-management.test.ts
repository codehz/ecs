import { describe, expect, it } from "bun:test";
import { component, createEntityId, relation } from "../core/entity";
import { World } from "../core/world";

describe("World - Entity Management", () => {
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

    world.delete(entity);
    world.sync();
    expect(world.exists(entity)).toBe(false);
  });

  it("should handle destroying non-existent entities gracefully", () => {
    const world = new World();
    const fakeEntity = createEntityId(9999);
    expect(world.exists(fakeEntity)).toBe(false);
    // Should not throw
    world.delete(fakeEntity);
  });

  it("should support component id as entity id with fast path storage", () => {
    const world = new World();
    const Meta = component<{ tag: string }>("Meta");
    const Payload = component<{ value: number }>("Payload");

    expect(world.exists(Meta)).toBe(true);

    world.set(Meta, Payload, { value: 42 });
    world.sync();

    expect(world.has(Meta, Payload)).toBe(true);
    expect(world.get(Meta, Payload)).toEqual({ value: 42 });

    const query = world.createQuery([Payload]);
    expect(query.getEntities()).toEqual([]);

    let hookCalls = 0;
    world.hook(Payload, {
      on_init: () => {
        hookCalls++;
      },
    });

    world.set(Meta, Payload, { value: 43 });
    world.sync();
    expect(hookCalls).toBe(0);

    world.delete(Meta);
    world.sync();
    expect(world.has(Meta, Payload)).toBe(false);
    expect(world.getOptional(Meta, Payload)).toBeUndefined();
    expect(world.exists(Meta)).toBe(true);
  });

  it("should clear relation-entity data when target entity is deleted", () => {
    const world = new World();
    const Link = component("Link");
    const Payload = component<{ value: number }>("Payload2");

    const target = world.new();
    const relationEntity = relation(Link, target);

    world.set(relationEntity, Payload, { value: 9 });
    world.sync();
    expect(world.has(relationEntity, Payload)).toBe(true);

    world.delete(target);
    world.sync();
    expect(world.has(relationEntity, Payload)).toBe(false);
    expect(world.getOptional(relationEntity, Payload)).toBeUndefined();
    expect(world.exists(relationEntity)).toBe(true);
  });
});
