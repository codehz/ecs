import { describe, expect, it } from "bun:test";
import { component, relation } from "./entity";
import { AssertionError, Assertions, EntityBuilder, Snapshot, WorldFixture, type WorldSnapshot } from "./testing";
import { World } from "./world";

// Test components
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { current: number; max: number };

const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const HealthId = component<Health>();
const TagId = component<void>();
const ParentId = component<{ offset: { x: number; y: number } }>();

describe("testing module", () => {
  describe("WorldFixture", () => {
    it("should create a world instance", () => {
      const fixture = new WorldFixture();
      expect(fixture.world).toBeInstanceOf(World);
    });

    it("should spawn entities with fluent API", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 10, y: 20 }).build();

      expect(fixture.world.exists(entity)).toBe(true);
      expect(fixture.world.has(entity, PositionId)).toBe(true);
      expect(fixture.world.get(entity, PositionId)).toEqual({ x: 10, y: 20 });
    });

    it("should spawn multiple entities", () => {
      const fixture = new WorldFixture();
      const entities = fixture.spawnMany(3, (builder, index) =>
        builder.with(PositionId, { x: index * 10, y: index * 20 }),
      );

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

      const query = fixture.createQuery([PositionId]);
      expect(query.getEntities()).toHaveLength(1);

      fixture.reset();
      expect(query.disposed).toBe(true);
    });

    it("should support Symbol.dispose", () => {
      const fixture = new WorldFixture();
      fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      const query = fixture.createQuery([PositionId]);

      fixture[Symbol.dispose]();
      expect(query.disposed).toBe(true);
    });
  });

  describe("EntityBuilder", () => {
    it("should build entity with multiple components", () => {
      const world = new World();
      const entity = new EntityBuilder(world)
        .with(PositionId, { x: 1, y: 2 })
        .with(VelocityId, { x: 3, y: 4 })
        .with(HealthId, { current: 100, max: 100 })
        .build();

      expect(world.has(entity, PositionId)).toBe(true);
      expect(world.has(entity, VelocityId)).toBe(true);
      expect(world.has(entity, HealthId)).toBe(true);
    });

    it("should support tag components", () => {
      const world = new World();
      const entity = new EntityBuilder(world).withTag(TagId).build();

      expect(world.has(entity, TagId)).toBe(true);
    });

    it("should support relations", () => {
      const world = new World();
      const parent = new EntityBuilder(world).with(PositionId, { x: 0, y: 0 }).build();

      const child = new EntityBuilder(world)
        .with(PositionId, { x: 10, y: 10 })
        .withRelation(ParentId, parent, { offset: { x: 5, y: 5 } })
        .build();

      const parentRelationId = relation(ParentId, parent);
      expect(world.has(child, parentRelationId)).toBe(true);
      expect(world.get(child, parentRelationId)).toEqual({ offset: { x: 5, y: 5 } });
    });

    it("should support relation tags", () => {
      const ChildOfId = component<void>();
      const world = new World();
      const parent = world.new();
      world.sync();

      const child = new EntityBuilder(world).withRelationTag(ChildOfId, parent).build();

      const relationId = relation(ChildOfId, parent);
      expect(world.has(child, relationId)).toBe(true);
    });

    it("should support deferred build", () => {
      const world = new World();
      const e1 = new EntityBuilder(world).with(PositionId, { x: 1, y: 1 }).buildDeferred();
      const e2 = new EntityBuilder(world).with(PositionId, { x: 2, y: 2 }).buildDeferred();

      // Components not yet applied
      expect(world.has(e1, PositionId)).toBe(false);
      expect(world.has(e2, PositionId)).toBe(false);

      world.sync();

      expect(world.has(e1, PositionId)).toBe(true);
      expect(world.has(e2, PositionId)).toBe(true);
    });
  });

  describe("Assertions", () => {
    describe("hasComponent / lacksComponent", () => {
      it("should return true when entity has component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

        expect(Assertions.hasComponent(fixture.world, entity, PositionId)).toBe(true);
        expect(Assertions.lacksComponent(fixture.world, entity, PositionId)).toBe(false);
      });

      it("should return false when entity lacks component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

        expect(Assertions.hasComponent(fixture.world, entity, VelocityId)).toBe(false);
        expect(Assertions.lacksComponent(fixture.world, entity, VelocityId)).toBe(true);
      });

      it("should handle non-existent entities", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();
        fixture.world.delete(entity);
        fixture.sync();

        expect(Assertions.hasComponent(fixture.world, entity, PositionId)).toBe(false);
        expect(Assertions.lacksComponent(fixture.world, entity, PositionId)).toBe(true);
      });
    });

    describe("getComponent", () => {
      it("should return component value", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 42, y: 84 }).build();

        expect(Assertions.getComponent(fixture.world, entity, PositionId)).toEqual({ x: 42, y: 84 });
      });

      it("should return undefined for missing component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();

        expect(Assertions.getComponent(fixture.world, entity, PositionId)).toBeUndefined();
      });
    });

    describe("entityExists", () => {
      it("should return true for existing entity", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();

        expect(Assertions.entityExists(fixture.world, entity)).toBe(true);
      });

      it("should return false for deleted entity", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();
        fixture.world.delete(entity);
        fixture.sync();

        expect(Assertions.entityExists(fixture.world, entity)).toBe(false);
      });
    });

    describe("query assertions", () => {
      it("should check query contains entities", () => {
        const fixture = new WorldFixture();
        const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
        const e2 = fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();
        const e3 = fixture.spawn().with(VelocityId, { x: 0, y: 0 }).build();

        const query = fixture.createQuery([PositionId]);

        expect(Assertions.queryContains(query, e1)).toBe(true);
        expect(Assertions.queryContains(query, e1, e2)).toBe(true);
        expect(Assertions.queryContains(query, e3)).toBe(false);
      });

      it("should check query contains exactly", () => {
        const fixture = new WorldFixture();
        const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
        const e2 = fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();

        const query = fixture.createQuery([PositionId]);

        expect(Assertions.queryContainsExactly(query, e1, e2)).toBe(true);
        expect(Assertions.queryContainsExactly(query, e1)).toBe(false);
      });

      it("should count query entities", () => {
        const fixture = new WorldFixture();
        fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
        fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();

        const query = fixture.createQuery([PositionId]);

        expect(Assertions.queryCount(query)).toBe(2);
      });
    });

    describe("throwing assertions", () => {
      it("assertHasComponent should throw for missing component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();

        expect(() => Assertions.assertHasComponent(fixture.world, entity, PositionId)).toThrow(AssertionError);
      });

      it("assertHasComponent should not throw for existing component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

        expect(() => Assertions.assertHasComponent(fixture.world, entity, PositionId)).not.toThrow();
      });

      it("assertLacksComponent should throw for existing component", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

        expect(() => Assertions.assertLacksComponent(fixture.world, entity, PositionId)).toThrow(AssertionError);
      });

      it("assertComponentEquals should throw for mismatched value", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 1, y: 2 }).build();

        expect(() => Assertions.assertComponentEquals(fixture.world, entity, PositionId, { x: 99, y: 99 })).toThrow(
          AssertionError,
        );
      });

      it("assertComponentEquals should not throw for matching value", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().with(PositionId, { x: 1, y: 2 }).build();

        expect(() => Assertions.assertComponentEquals(fixture.world, entity, PositionId, { x: 1, y: 2 })).not.toThrow();
      });

      it("assertEntityExists should throw for non-existent entity", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();
        fixture.world.delete(entity);
        fixture.sync();

        expect(() => Assertions.assertEntityExists(fixture.world, entity)).toThrow(AssertionError);
      });

      it("assertEntityNotExists should throw for existing entity", () => {
        const fixture = new WorldFixture();
        const entity = fixture.spawn().build();

        expect(() => Assertions.assertEntityNotExists(fixture.world, entity)).toThrow(AssertionError);
      });

      it("assertQueryContains should throw when entity missing", () => {
        const fixture = new WorldFixture();
        const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
        const e2 = fixture.spawn().with(VelocityId, { x: 0, y: 0 }).build();

        const query = fixture.createQuery([PositionId]);

        expect(() => Assertions.assertQueryContains(query, e2)).toThrow(AssertionError);
        expect(() => Assertions.assertQueryContains(query, e1)).not.toThrow();
      });

      it("assertQueryNotContains should throw when entity present", () => {
        const fixture = new WorldFixture();
        const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

        const query = fixture.createQuery([PositionId]);

        expect(() => Assertions.assertQueryNotContains(query, e1)).toThrow(AssertionError);
      });
    });

    describe("relation assertions", () => {
      it("should check hasRelation", () => {
        const fixture = new WorldFixture();
        const parent = fixture.spawn().build();
        const child = fixture
          .spawn()
          .withRelation(ParentId, parent, { offset: { x: 0, y: 0 } })
          .build();

        expect(Assertions.hasRelation(fixture.world, child, ParentId, parent)).toBe(true);
        expect(Assertions.hasRelation(fixture.world, parent, ParentId, child)).toBe(false);
      });

      it("should get relations via wildcard", () => {
        const fixture = new WorldFixture();
        const target1 = fixture.spawn().build();
        const target2 = fixture.spawn().build();
        const entity = fixture
          .spawn()
          .withRelation(ParentId, target1, { offset: { x: 1, y: 1 } })
          .withRelation(ParentId, target2, { offset: { x: 2, y: 2 } })
          .build();

        const relations = Assertions.getRelations(fixture.world, entity, ParentId);
        expect(relations).toHaveLength(2);
      });
    });
  });

  describe("Snapshot", () => {
    it("should capture entity state", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 10, y: 20 }).with(VelocityId, { x: 1, y: 2 }).build();

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
      const after = Snapshot.capture(fixture.world, [entity], [PositionId]);

      const diff = Snapshot.compare(before, after);

      expect(diff.addedEntities).toContain(entity);
      expect(diff.removedEntities).toHaveLength(0);
    });

    it("should detect removed entities in diff", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
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

      const before = Snapshot.capture(fixture.world, [entity], [PositionId]);

      // Modify component
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

      const snapshot1 = Snapshot.capture(fixture.world, [entity], [PositionId]);
      const snapshot2 = Snapshot.capture(fixture.world, [entity], [PositionId]);

      expect(Snapshot.equals(snapshot1, snapshot2)).toBe(true);
    });

    it("should isolate snapshots from mutations", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();

      const snapshot = Snapshot.capture(fixture.world, [entity], [PositionId]);

      // Mutate original component
      fixture.world.set(entity, PositionId, { x: 999, y: 999 });
      fixture.sync();

      // Snapshot should still have original value
      expect(snapshot.entities[0]!.components.get(PositionId)).toEqual({ x: 0, y: 0 });
    });
  });
});
