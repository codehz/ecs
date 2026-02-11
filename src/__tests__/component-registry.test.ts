import { describe, expect, it } from "bun:test";
import { ComponentIdAllocator } from "../core/entity-manager";
import { COMPONENT_ID_MAX, createComponentId } from "../core/entity-types";

describe("ComponentIdAllocator", () => {
  it("should allocate component IDs sequentially", () => {
    const allocator = new ComponentIdAllocator();

    const id1 = allocator.allocate();
    const id2 = allocator.allocate();
    const id3 = allocator.allocate();

    expect(id1).toBe(createComponentId(1));
    expect(id2).toBe(createComponentId(2));
    expect(id3).toBe(createComponentId(3));
  });

  it("should throw when exceeding COMPONENT_ID_MAX", () => {
    const allocator = new ComponentIdAllocator();

    // Allocate up to the limit
    for (let i = 1; i <= COMPONENT_ID_MAX; i++) {
      allocator.allocate();
    }

    // The next allocation should throw
    expect(() => allocator.allocate()).toThrow(/out of component IDs|overflow/i);
  });

  it("should check availability correctly", () => {
    const allocator = new ComponentIdAllocator();

    expect(allocator.hasAvailableIds()).toBe(true);

    // Allocate up to the limit
    for (let i = 1; i <= COMPONENT_ID_MAX; i++) {
      allocator.allocate();
    }

    expect(allocator.hasAvailableIds()).toBe(false);
  });

  it("should track next ID correctly", () => {
    const allocator = new ComponentIdAllocator();

    expect(allocator.getNextId()).toBe(1);

    allocator.allocate();
    expect(allocator.getNextId()).toBe(2);

    allocator.allocate();
    expect(allocator.getNextId()).toBe(3);
  });

  it("should allocate exactly COMPONENT_ID_MAX IDs", () => {
    const allocator = new ComponentIdAllocator();

    for (let i = 1; i <= COMPONENT_ID_MAX; i++) {
      const id = allocator.allocate();
      expect(id).toBe(createComponentId(i));
    }

    // Should be exhausted now
    expect(allocator.hasAvailableIds()).toBe(false);
  });
});
