import { describe, expect, it } from "bun:test";
import { component } from "./entity";
import { ComponentChangeset } from "./changeset";

describe("ComponentChangeset", () => {
  const PositionId = component<{ x: number; y: number }>();
  const VelocityId = component<{ x: number; y: number }>();
  const HealthId = component<number>();

  describe("Basic Operations", () => {
    it("should start with no changes", () => {
      const changeset = new ComponentChangeset();
      expect(changeset.hasChanges()).toBe(false);
      expect(changeset.adds.size).toBe(0);
      expect(changeset.removes.size).toBe(0);
    });

    it("should add components", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });

      expect(changeset.hasChanges()).toBe(true);
      expect(changeset.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset.removes.size).toBe(0);
    });

    it("should remove components", () => {
      const changeset = new ComponentChangeset();
      changeset.removeComponent(PositionId);

      expect(changeset.hasChanges()).toBe(true);
      expect(changeset.adds.size).toBe(0);
      expect(changeset.removes.has(PositionId)).toBe(true);
    });

    it("should clear all changes", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });
      changeset.removeComponent(VelocityId);

      expect(changeset.hasChanges()).toBe(true);

      changeset.clear();

      expect(changeset.hasChanges()).toBe(false);
      expect(changeset.adds.size).toBe(0);
      expect(changeset.removes.size).toBe(0);
    });
  });

  describe("Conflict Resolution", () => {
    it("should remove from removes when adding a component that was going to be removed", () => {
      const changeset = new ComponentChangeset();
      changeset.removeComponent(PositionId);
      changeset.addComponent(PositionId, { x: 10, y: 20 });

      expect(changeset.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset.removes.has(PositionId)).toBe(false);
    });

    it("should remove from adds when removing a component that was going to be added", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });
      changeset.removeComponent(PositionId);

      expect(changeset.adds.has(PositionId)).toBe(false);
      expect(changeset.removes.has(PositionId)).toBe(true);
    });
  });

  describe("Apply Changes", () => {
    it("should apply additions to existing components", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });
      changeset.addComponent(VelocityId, { x: 1, y: 2 });

      const existing = new Map();
      existing.set(HealthId, 100);

      const result = changeset.applyTo(existing);

      expect(result.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(result.get(VelocityId)).toEqual({ x: 1, y: 2 });
      expect(result.get(HealthId)).toBe(100);
    });

    it("should apply removals to existing components", () => {
      const changeset = new ComponentChangeset();
      changeset.removeComponent(PositionId);

      const existing = new Map();
      existing.set(PositionId, { x: 10, y: 20 });
      existing.set(VelocityId, { x: 1, y: 2 });

      const result = changeset.applyTo(existing);

      expect(result.has(PositionId)).toBe(false);
      expect(result.get(VelocityId)).toEqual({ x: 1, y: 2 });
    });

    it("should apply both additions and removals", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 50, y: 60 });
      changeset.removeComponent(VelocityId);

      const existing = new Map();
      existing.set(PositionId, { x: 10, y: 20 });
      existing.set(VelocityId, { x: 1, y: 2 });
      existing.set(HealthId, 100);

      const result = changeset.applyTo(existing);

      expect(result.get(PositionId)).toEqual({ x: 50, y: 60 }); // Updated
      expect(result.has(VelocityId)).toBe(false); // Removed
      expect(result.get(HealthId)).toBe(100); // Unchanged
    });

    it("should get final component types correctly", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });
      changeset.removeComponent(VelocityId);

      const existing = new Map();
      existing.set(VelocityId, { x: 1, y: 2 });
      existing.set(HealthId, 100);

      const finalTypes = changeset.getFinalComponentTypes(existing);

      expect(finalTypes).toEqual([PositionId, HealthId]); // Sorted by ID
    });
  });

  describe("Direct Access", () => {
    it("should return direct references to internal maps for performance", () => {
      const changeset = new ComponentChangeset();
      changeset.addComponent(PositionId, { x: 10, y: 20 });

      const adds = changeset.adds;
      const removes = changeset.removes;

      // Since this is internal API, direct modification is allowed
      adds.clear();
      removes.add(VelocityId);

      expect(changeset.adds.size).toBe(0);
      expect(changeset.removes.size).toBe(1);
    });
  });
});
