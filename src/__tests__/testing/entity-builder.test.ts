import { beforeEach, describe, expect, it } from "bun:test";
import { component, relation, type ComponentId } from "../../entity";
import { EntityBuilder } from "../../testing/index";
import { World } from "../../world/world";

let PositionId: ComponentId<{ x: number; y: number }>;
let VelocityId: ComponentId<{ x: number; y: number }>;
let HealthId: ComponentId<{ current: number; max: number }>;
let TagId: ComponentId<void>;
let ParentId: ComponentId<{ offset: { x: number; y: number } }>;

describe("EntityBuilder", () => {
  beforeEach(() => {
    PositionId = component<{ x: number; y: number }>();
    VelocityId = component<{ x: number; y: number }>();
    HealthId = component<{ current: number; max: number }>();
    TagId = component<void>();
    ParentId = component<{ offset: { x: number; y: number } }>();
  });

  it("should build entity with multiple components", () => {
    const world = new World();
    const entity = new EntityBuilder(world)
      .with(PositionId, { x: 1, y: 2 })
      .with(VelocityId, { x: 3, y: 4 })
      .with(HealthId, { current: 100, max: 100 })
      .build();
    world.sync();

    expect(world.has(entity, PositionId)).toBe(true);
    expect(world.has(entity, VelocityId)).toBe(true);
    expect(world.has(entity, HealthId)).toBe(true);
  });

  it("should support tag components", () => {
    const world = new World();
    const entity = new EntityBuilder(world).with(TagId).build();
    world.sync();

    expect(world.has(entity, TagId)).toBe(true);
  });

  it("should support relations", () => {
    const world = new World();
    const parent = new EntityBuilder(world).with(PositionId, { x: 0, y: 0 }).build();

    const child = new EntityBuilder(world)
      .with(PositionId, { x: 10, y: 10 })
      .withRelation(ParentId, parent, { offset: { x: 5, y: 5 } })
      .build();
    world.sync();

    const parentRelationId = relation(ParentId, parent);
    expect(world.has(child, parentRelationId)).toBe(true);
    expect(world.get(child, parentRelationId)).toEqual({ offset: { x: 5, y: 5 } });
  });

  it("should support relation tags", () => {
    const ChildOfId = component<void>();
    const world = new World();
    const parent = world.new();
    world.sync();

    const child = new EntityBuilder(world).withRelation(ChildOfId, parent).build();
    world.sync();

    const relationId = relation(ChildOfId, parent);
    expect(world.has(child, relationId)).toBe(true);
  });

  it("should support deferred build", () => {
    const world = new World();
    const e1 = new EntityBuilder(world).with(PositionId, { x: 1, y: 1 }).build();
    const e2 = new EntityBuilder(world).with(PositionId, { x: 2, y: 2 }).build();

    expect(world.has(e1, PositionId)).toBe(false);
    expect(world.has(e2, PositionId)).toBe(false);

    world.sync();

    expect(world.has(e1, PositionId)).toBe(true);
    expect(world.has(e2, PositionId)).toBe(true);
  });
});
