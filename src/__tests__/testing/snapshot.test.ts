import { beforeEach, describe, expect, it } from "bun:test";
import { component, type ComponentId } from "../../entity";
import { Snapshot, WorldFixture, type WorldSnapshot } from "../../testing/index";

let PositionId: ComponentId<{ x: number; y: number }>;
let VelocityId: ComponentId<{ x: number; y: number }>;

describe("Snapshot", () => {
  beforeEach(() => {
    PositionId = component<{ x: number; y: number }>();
    VelocityId = component<{ x: number; y: number }>();
  });

  it("should capture entity state", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 10, y: 20 }).with(VelocityId, { x: 1, y: 2 }).build();
    fixture.sync();
    const snapshot = Snapshot.capture(fixture.world, [entity], [PositionId, VelocityId]);

    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0]!.entity).toBe(entity);
    expect(snapshot.entities[0]!.components.get(PositionId)).toEqual({ x: 10, y: 20 });
    expect(snapshot.entities[0]!.components.get(VelocityId)).toEqual({ x: 1, y: 2 });
  });

  it("should capture multiple entities", () => {
    const fixture = new WorldFixture();
    const e1 = fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();
    const e2 = fixture.spawn().with(PositionId, { x: 2, y: 2 }).build();
    fixture.sync();

    const snapshot = Snapshot.capture(fixture.world, [e1, e2], [PositionId]);

    expect(snapshot.entities).toHaveLength(2);
  });

  it("should skip non-existent entities", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.world.delete(entity);
    fixture.sync();

    const snapshot = Snapshot.capture(fixture.world, [entity], [PositionId]);

    expect(snapshot.entities).toHaveLength(0);
  });

  it("should detect added entities in diff", () => {
    const before: WorldSnapshot = { entities: [] };
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const after = Snapshot.capture(fixture.world, [entity], [PositionId]);

    const diff = Snapshot.compare(before, after);

    expect(diff.addedEntities).toContain(entity);
    expect(diff.removedEntities).toHaveLength(0);
  });

  it("should detect removed entities in diff", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const before = Snapshot.capture(fixture.world, [entity], [PositionId]);

    fixture.world.delete(entity);
    fixture.sync();

    const after = Snapshot.capture(fixture.world, [entity], [PositionId]);
    const diff = Snapshot.compare(before, after);

    expect(diff.removedEntities).toContain(entity);
    expect(diff.addedEntities).toHaveLength(0);
  });

  it("should detect component changes in diff", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const before = Snapshot.capture(fixture.world, [entity], [PositionId]);

    fixture.world.set(entity, PositionId, { x: 100, y: 200 });
    fixture.sync();

    const after = Snapshot.capture(fixture.world, [entity], [PositionId]);
    const diff = Snapshot.compare(before, after);

    expect(diff.componentChanges).toHaveLength(1);
    expect(diff.componentChanges[0]!.changeType).toBe("modified");
    expect(diff.componentChanges[0]!.before).toEqual({ x: 0, y: 0 });
    expect(diff.componentChanges[0]!.after).toEqual({ x: 100, y: 200 });
  });

  it("should detect added components in diff", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const before = Snapshot.capture(fixture.world, [entity], [PositionId, VelocityId]);

    fixture.world.set(entity, VelocityId, { x: 1, y: 1 });
    fixture.sync();

    const after = Snapshot.capture(fixture.world, [entity], [PositionId, VelocityId]);
    const diff = Snapshot.compare(before, after);

    const velocityChange = diff.componentChanges.find((c) => c.componentId === VelocityId);
    expect(velocityChange).toBeDefined();
    expect(velocityChange!.changeType).toBe("added");
  });

  it("should detect removed components in diff", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).with(VelocityId, { x: 1, y: 1 }).build();
    fixture.sync();
    const before = Snapshot.capture(fixture.world, [entity], [PositionId, VelocityId]);

    fixture.world.remove(entity, VelocityId);
    fixture.sync();

    const after = Snapshot.capture(fixture.world, [entity], [PositionId, VelocityId]);
    const diff = Snapshot.compare(before, after);

    const velocityChange = diff.componentChanges.find((c) => c.componentId === VelocityId);
    expect(velocityChange).toBeDefined();
    expect(velocityChange!.changeType).toBe("removed");
  });

  it("should check snapshot equality", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const snapshot1 = Snapshot.capture(fixture.world, [entity], [PositionId]);
    const snapshot2 = Snapshot.capture(fixture.world, [entity], [PositionId]);

    expect(Snapshot.equals(snapshot1, snapshot2)).toBe(true);
  });

  it("should isolate snapshots from mutations", () => {
    const fixture = new WorldFixture();
    const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
    fixture.sync();
    const snapshot = Snapshot.capture(fixture.world, [entity], [PositionId]);

    fixture.world.set(entity, PositionId, { x: 999, y: 999 });
    fixture.sync();

    expect(snapshot.entities[0]!.components.get(PositionId)).toEqual({ x: 0, y: 0 });
  });
});
