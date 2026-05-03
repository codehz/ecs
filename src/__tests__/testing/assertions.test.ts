import { beforeEach, describe, expect, it } from "bun:test";
import { component, type ComponentId } from "../../entity";
import { AssertionError, Assertions, WorldFixture } from "../../testing/index";

let PositionId: ComponentId<{ x: number; y: number }>;
let VelocityId: ComponentId<{ x: number; y: number }>;
let ParentId: ComponentId<{ offset: { x: number; y: number } }>;

describe("Assertions", () => {
  beforeEach(() => {
    PositionId = component<{ x: number; y: number }>();
    VelocityId = component<{ x: number; y: number }>();
    ParentId = component<{ offset: { x: number; y: number } }>();
  });

  describe("hasComponent / lacksComponent", () => {
    it("should return true when entity has component", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      fixture.sync();
      expect(Assertions.hasComponent(fixture.world, entity, PositionId)).toBe(true);
      expect(Assertions.lacksComponent(fixture.world, entity, PositionId)).toBe(false);
    });

    it("should return false when entity lacks component", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      fixture.sync();
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
      fixture.sync();
      expect(Assertions.getComponent(fixture.world, entity, PositionId)).toEqual({ x: 42, y: 84 });
    });

    it("should return undefined for missing component", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().build();
      fixture.sync();
      expect(Assertions.getComponent(fixture.world, entity, PositionId)).toBeUndefined();
    });
  });

  describe("entityExists", () => {
    it("should return true for existing entity", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().build();
      fixture.sync();
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
      fixture.sync();

      const query = fixture.createQuery([PositionId]);

      expect(Assertions.queryContains(query, e1)).toBe(true);
      expect(Assertions.queryContains(query, e1, e2)).toBe(true);
      expect(Assertions.queryContains(query, e3)).toBe(false);
    });

    it("should check query contains exactly", () => {
      const fixture = new WorldFixture();
      const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      const e2 = fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();
      fixture.sync();

      const query = fixture.createQuery([PositionId]);

      expect(Assertions.queryContainsExactly(query, e1, e2)).toBe(true);
      expect(Assertions.queryContainsExactly(query, e1)).toBe(false);
    });

    it("should count query entities", () => {
      const fixture = new WorldFixture();
      fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      fixture.sync();
      fixture.spawn().with(PositionId, { x: 1, y: 1 }).build();
      fixture.sync();

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
      fixture.sync();
      expect(() => Assertions.assertHasComponent(fixture.world, entity, PositionId)).not.toThrow();
    });

    it("assertLacksComponent should throw for existing component", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      fixture.sync();
      expect(() => Assertions.assertLacksComponent(fixture.world, entity, PositionId)).toThrow(AssertionError);
    });

    it("assertComponentEquals should throw for mismatched value", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 1, y: 2 }).build();
      fixture.sync();
      expect(() => Assertions.assertComponentEquals(fixture.world, entity, PositionId, { x: 99, y: 99 })).toThrow(
        AssertionError,
      );
    });

    it("assertComponentEquals should not throw for matching value", () => {
      const fixture = new WorldFixture();
      const entity = fixture.spawn().with(PositionId, { x: 1, y: 2 }).build();
      fixture.sync();
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
      fixture.sync();

      const query = fixture.createQuery([PositionId]);

      expect(() => Assertions.assertQueryContains(query, e2)).toThrow(AssertionError);
      expect(() => Assertions.assertQueryContains(query, e1)).not.toThrow();
    });

    it("assertQueryNotContains should throw when entity present", () => {
      const fixture = new WorldFixture();
      const e1 = fixture.spawn().with(PositionId, { x: 0, y: 0 }).build();
      fixture.sync();

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
      fixture.sync();

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
      fixture.sync();

      const relations = Assertions.getRelations(fixture.world, entity, ParentId);
      expect(relations).toHaveLength(2);
    });
  });
});
