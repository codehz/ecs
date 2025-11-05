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

  describe("Merge Changesets", () => {
    it("should merge additions into an empty changeset", () => {
      const changeset1 = new ComponentChangeset();
      const changeset2 = new ComponentChangeset();
      changeset2.addComponent(PositionId, { x: 10, y: 20 });
      changeset2.addComponent(VelocityId, { x: 1, y: 2 });

      changeset1.merge(changeset2);

      expect(changeset1.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset1.adds.get(VelocityId)).toEqual({ x: 1, y: 2 });
      expect(changeset1.removes.size).toBe(0);
      expect(changeset1.hasChanges()).toBe(true);
    });

    it("should merge removals into an empty changeset", () => {
      const changeset1 = new ComponentChangeset();
      const changeset2 = new ComponentChangeset();
      changeset2.removeComponent(PositionId);
      changeset2.removeComponent(VelocityId);

      changeset1.merge(changeset2);

      expect(changeset1.removes.has(PositionId)).toBe(true);
      expect(changeset1.removes.has(VelocityId)).toBe(true);
      expect(changeset1.adds.size).toBe(0);
      expect(changeset1.hasChanges()).toBe(true);
    });

    it("should merge additions and removals together", () => {
      const changeset1 = new ComponentChangeset();
      const changeset2 = new ComponentChangeset();
      changeset2.addComponent(PositionId, { x: 10, y: 20 });
      changeset2.removeComponent(VelocityId);

      changeset1.merge(changeset2);

      expect(changeset1.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset1.removes.has(VelocityId)).toBe(true);
      expect(changeset1.hasChanges()).toBe(true);
    });

    it("should override removal with addition when merging", () => {
      const changeset1 = new ComponentChangeset();
      changeset1.removeComponent(PositionId); // Initially removing

      const changeset2 = new ComponentChangeset();
      changeset2.addComponent(PositionId, { x: 10, y: 20 }); // Adding the same component

      changeset1.merge(changeset2);

      expect(changeset1.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset1.removes.has(PositionId)).toBe(false);
    });

    it("should override addition with removal when merging", () => {
      const changeset1 = new ComponentChangeset();
      changeset1.addComponent(PositionId, { x: 5, y: 5 }); // Initially adding

      const changeset2 = new ComponentChangeset();
      changeset2.removeComponent(PositionId); // Removing the same component

      changeset1.merge(changeset2);

      expect(changeset1.adds.has(PositionId)).toBe(false);
      expect(changeset1.removes.has(PositionId)).toBe(true);
    });

    it("should merge multiple changesets sequentially", () => {
      const changeset1 = new ComponentChangeset();
      changeset1.addComponent(PositionId, { x: 10, y: 20 });

      const changeset2 = new ComponentChangeset();
      changeset2.removeComponent(PositionId);
      changeset2.addComponent(VelocityId, { x: 1, y: 2 });

      const changeset3 = new ComponentChangeset();
      changeset3.removeComponent(VelocityId);
      changeset3.addComponent(HealthId, 100);

      changeset1.merge(changeset2);
      changeset1.merge(changeset3);

      expect(changeset1.adds.has(PositionId)).toBe(false); // Removed by changeset2
      expect(changeset1.removes.has(PositionId)).toBe(true);
      expect(changeset1.adds.has(VelocityId)).toBe(false); // Removed by changeset3
      expect(changeset1.removes.has(VelocityId)).toBe(true);
      expect(changeset1.adds.get(HealthId)).toBe(100);
      expect(changeset1.hasChanges()).toBe(true);
    });

    it("should handle merging empty changeset", () => {
      const changeset1 = new ComponentChangeset();
      changeset1.addComponent(PositionId, { x: 10, y: 20 });

      const changeset2 = new ComponentChangeset(); // Empty

      changeset1.merge(changeset2);

      expect(changeset1.adds.get(PositionId)).toEqual({ x: 10, y: 20 });
      expect(changeset1.removes.size).toBe(0);
      expect(changeset1.hasChanges()).toBe(true);
    });
  });
});
