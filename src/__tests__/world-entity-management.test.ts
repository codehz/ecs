import { describe, expect, it } from "bun:test";
import { createEntityId } from "../core/entity";
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
});
