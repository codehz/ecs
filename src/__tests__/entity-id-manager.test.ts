import { describe, expect, it } from "bun:test";
import { EntityIdManager } from "../core/entity-manager";
import type { EntityId } from "../testing";

describe("EntityIdManager", () => {
  it("should allocate entity IDs sequentially", () => {
    const manager = new EntityIdManager();

    const id1 = manager.allocate();
    const id2 = manager.allocate();
    const id3 = manager.allocate();

    // Entity IDs start at 1024
    expect(Number(id1 as unknown as number)).toBe(1024);
    expect(Number(id2 as unknown as number)).toBe(1025);
    expect(Number(id3 as unknown as number)).toBe(1026);
  });

  it("should reuse freed entity IDs (LIFO)", () => {
    const manager = new EntityIdManager();

    const id1 = manager.allocate();
    const id2 = manager.allocate();
    const id3 = manager.allocate();

    // Free in order
    manager.deallocate(id1);
    manager.deallocate(id2);
    manager.deallocate(id3);

    // Should reuse in LIFO order (last freed is first reused)
    expect(manager.allocate()).toBe(id3);
    expect(manager.allocate()).toBe(id2);
    expect(manager.allocate()).toBe(id1);
  });

  it("should handle large number of allocations", () => {
    const manager = new EntityIdManager();
    const ids = new Set<number>();

    // Allocate 10000 IDs
    for (let i = 0; i < 10000; i++) {
      ids.add(manager.allocate());
    }

    expect(ids.size).toBe(10000);
  });

  it("should handle interleaved allocate and free", () => {
    const manager = new EntityIdManager();
    const allocated: number[] = [];

    // Allocate some IDs
    for (let i = 0; i < 100; i++) {
      allocated.push(manager.allocate());
    }

    expect(manager.getFreelistSize()).toBe(0);

    // Free every third ID
    const toReuse = [];
    for (let i = 0; i < allocated.length; i += 3) {
      manager.deallocate(allocated[i]! as EntityId<any>);
      toReuse.push(allocated[i]!);
    }

    const freelistSize = manager.getFreelistSize();
    expect(freelistSize).toBe(Math.ceil(allocated.length / 3));

    // Allocate new IDs - should reuse freed ones
    for (let i = 0; i < toReuse.length; i++) {
      const newId = manager.allocate();
      expect(toReuse).toContain(newId);
    }

    expect(manager.getFreelistSize()).toBe(0);
  });

  it("should maintain freelist as LIFO stack", () => {
    const manager = new EntityIdManager();

    const id1 = manager.allocate();
    const id2 = manager.allocate();
    const id3 = manager.allocate();

    // Free in specific order
    manager.deallocate(id1);
    manager.deallocate(id2);
    manager.deallocate(id3);

    expect(manager.getFreelistSize()).toBe(3);

    // Last freed (id3) should be popped first (LIFO)
    const reused1 = manager.allocate();
    expect(reused1).toBe(id3);

    const reused2 = manager.allocate();
    expect(reused2).toBe(id2);

    const reused3 = manager.allocate();
    expect(reused3).toBe(id1);

    expect(manager.getFreelistSize()).toBe(0);
  });

  it("should throw when deallocating invalid entity ID", () => {
    const manager = new EntityIdManager();
    manager.allocate();

    // Deallocating negative ID or ID that was never allocated
    expect(() => manager.deallocate(0 as unknown as ReturnType<typeof manager.allocate>)).toThrow(
      /valid entity|deallocate/i,
    );
  });

  it("should serialize and deserialize state", () => {
    const manager = new EntityIdManager();

    const id1 = manager.allocate();
    manager.allocate();

    manager.deallocate(id1);

    const state = manager.serializeState();
    expect(state.nextId).toBe(1026);
    expect(state.freelist).toContain(id1);

    const newManager = new EntityIdManager();
    newManager.deserializeState(state);

    expect(newManager.getNextId()).toBe(1026);
    expect(newManager.getFreelistSize()).toBe(1);

    // Should reuse the freed ID
    const reused = newManager.allocate();
    expect(reused).toBe(id1);
  });

  it("should allocate new IDs after reusing freelist", () => {
    const manager = new EntityIdManager();

    const id1 = manager.allocate();
    const id2 = manager.allocate();
    manager.allocate();

    manager.deallocate(id1);
    manager.deallocate(id2);

    // Reuse freed IDs
    expect(manager.allocate()).toBe(id2);
    expect(manager.allocate()).toBe(id1);

    // Next allocation should be a new ID
    const newId = manager.allocate();
    expect(Number(newId as unknown as number)).toBe(1027);
  });
});
