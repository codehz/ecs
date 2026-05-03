import { beforeEach, describe, expect, it } from "bun:test";
import { component, type ComponentId } from "../../entity";
import { WorldFixture } from "../../testing/index";
import { World } from "../../world/world";

let PositionId: ComponentId<{ x: number; y: number }>;
let VelocityId: ComponentId<{ x: number; y: number }>;

describe("WorldFixture", () => {
  beforeEach(() => {
    PositionId = component<{ x: number; y: number }>();
    VelocityId = component<{ x: number; y: number }>();
  });

  it("should create a world instance", () => {
    const fixture = new WorldFixture();
    expect(fixture.world).toBeInstanceOf(World);
  });

  it("should spawn entities with fluent API", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 10, y: 20 }).build();
    fixture.sync();

    expect(fixture.world.exists(entity)).toBe(true);
    expect(fixture.world.has(entity, PositionId)).toBe(true);
    expect(fixture.world.get(entity, PositionId)).toEqual({ x: 10, y: 20 });
  });

  it("should spawn multiple entities", () => {
    const fixture = new WorldFixture();
    const entities = fixture.spawnMany(3, (builder, index) =>
      builder.with(PositionId, { x: index * 10, y: index * 20 }),
    );
    fixture.sync();

    expect(entities).toHaveLength(3);
    expect(fixture.world.get(entities[0]!, PositionId)).toEqual({ x: 0, y: 0 });
    expect(fixture.world.get(entities[1]!, PositionId)).toEqual({ x: 10, y: 20 });
    expect(fixture.world.get(entities[2]!, PositionId)).toEqual({ x: 20, y: 40 });
  });

  it("should reset to fresh world", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 10, y: 20 }).build();
    const oldWorld = fixture.world;

    fixture.reset();

    expect(fixture.world).not.toBe(oldWorld);
    expect(fixture.world.exists(entity)).toBe(false);
  });

  it("should track and dispose queries on reset", () => {
    const fixture = new WorldFixture();
    fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();

    const query = fixture.createQuery([PositionId]);
    expect(query.getEntities()).toHaveLength(1);

    fixture.reset();
    expect(query.disposed).toBe(true);
  });

  it("should support Symbol.dispose", () => {
    const fixture = new WorldFixture();
    fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const query = fixture.createQuery([PositionId]);

    fixture[Symbol.dispose]();
    expect(query.disposed).toBe(true);
  });
});
