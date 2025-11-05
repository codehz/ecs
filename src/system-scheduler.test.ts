import { describe, expect, it } from "bun:test";
import { SystemScheduler } from "./system-scheduler";
import type { System } from "./system";

describe("SystemScheduler", () => {
  it("should add and remove systems correctly", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {} };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB, [systemA]);

    expect(scheduler.getExecutionOrder()).toEqual([systemA, systemB]);

    scheduler.removeSystem(systemA);

    // After removing systemA, systemB should still exist but without dependencies
    expect(scheduler.getExecutionOrder()).toEqual([systemB]);
  });

  it("should clean up dependencies when removing systems", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {} };
    const systemC: System = { update: () => {} };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB, [systemA]);
    scheduler.addSystem(systemC, [systemB]);

    // Verify initial state
    expect(scheduler.getExecutionOrder()).toEqual([systemA, systemB, systemC]);

    // Remove systemB
    scheduler.removeSystem(systemB);

    // Now systemC should no longer depend on systemB
    // Since systemC's dependencies were cleaned up, it should execute independently
    const order = scheduler.getExecutionOrder();
    expect(order).toContain(systemA);
    expect(order).toContain(systemC);
    expect(order).not.toContain(systemB);

    // systemA should come before systemC in the execution order
    const aIndex = order.indexOf(systemA);
    const cIndex = order.indexOf(systemC);
    expect(aIndex).toBeLessThan(cIndex);
  });

  it("should handle removing non-existent systems gracefully", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {} };

    scheduler.addSystem(systemA);

    // Removing a system that was never added should not throw
    expect(() => scheduler.removeSystem(systemB)).not.toThrow();

    // systemA should still be there
    expect(scheduler.getExecutionOrder()).toEqual([systemA]);
  });

  it("should clear all systems", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {} };

    scheduler.addSystem(systemA, [systemB]);
    scheduler.addSystem(systemB);

    expect(scheduler.getExecutionOrder()).toHaveLength(2);

    scheduler.clear();

    expect(scheduler.getExecutionOrder()).toHaveLength(0);
  });
});
