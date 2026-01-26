import { describe, expect, it } from "bun:test";
import { component, relation } from "../entity";
import { World } from "../world";

describe("World.getOptional", () => {
  it("should return { value: T } when component exists", () => {
    const world = new World();
    const PositionId = component<{ x: number; y: number }>();
    const entity = world.new();
    world.set(entity, PositionId, { x: 10, y: 20 });
    world.sync();

    const result = world.getOptional(entity, PositionId);
    expect(result).toEqual({ value: { x: 10, y: 20 } });
  });

  it("should return undefined when component does not exist", () => {
    const world = new World();
    const PositionId = component<{ x: number; y: number }>();
    const VelocityId = component<{ x: number; y: number }>();
    const entity = world.new();
    world.set(entity, PositionId, { x: 10, y: 20 });
    world.sync();

    const result = world.getOptional(entity, VelocityId);
    expect(result).toBeUndefined();
  });

  it("should distinguish between component value being undefined and component not existing", () => {
    const world = new World();
    const UndefinedComponent = component<undefined>();
    const entity = world.new();
    world.set(entity, UndefinedComponent, undefined);
    world.sync();

    // Exists with undefined value
    expect(world.getOptional(entity, UndefinedComponent)).toEqual({ value: undefined });

    // Not existing
    const Other = component<number>();
    expect(world.getOptional(entity, Other)).toBeUndefined();
  });

  it("should throw error when entity does not exist", () => {
    const world = new World();
    const PositionId = component<{ x: number; y: number }>();
    const entity = 1234 as any; // non-existent entity

    expect(() => world.getOptional(entity, PositionId)).toThrow("Entity 1234 does not exist");
  });

  it("should return undefined for wildcard relations", () => {
    const world = new World();
    const Rel = component<number>();
    const target = world.new();
    const entity = world.new();
    world.set(entity, relation(Rel, target), 100);
    world.sync();

    const wildcard = relation(Rel, "*");
    expect(world.getOptional(entity, wildcard as any)).toBeUndefined();
  });

  it("should work with dontFragment relations", () => {
    const world = new World();
    const DFRel = component<number>({ dontFragment: true });
    const target = world.new();
    const entity = world.new();
    world.set(entity, relation(DFRel, target), 42);
    world.sync();

    const relId = relation(DFRel, target);
    expect(world.getOptional(entity, relId)).toEqual({ value: 42 });

    const otherTarget = world.new();
    const otherRelId = relation(DFRel, otherTarget);
    expect(world.getOptional(entity, otherRelId)).toBeUndefined();
  });
});
