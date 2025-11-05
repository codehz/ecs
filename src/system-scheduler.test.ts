import { describe, expect, it } from "bun:test";
import { SystemScheduler } from "./system-scheduler";
import type { System } from "./system";

describe("SystemScheduler", () => {
  it("should add systems correctly", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {}, dependencies: [systemA] };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB);

    expect(scheduler.getExecutionOrder()).toEqual([systemA, systemB]);
  });

  it("should handle complex dependencies", () => {
    const scheduler = new SystemScheduler();
    const systemA: System = { update: () => {} };
    const systemB: System = { update: () => {}, dependencies: [systemA] };
    const systemC: System = { update: () => {}, dependencies: [systemB] };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB);
    scheduler.addSystem(systemC);

    // Verify execution order
    expect(scheduler.getExecutionOrder()).toEqual([systemA, systemB, systemC]);
  });

  it("should clear all systems", () => {
    const scheduler = new SystemScheduler();
    const systemB: System = { update: () => {} };
    const systemA: System = { update: () => {}, dependencies: [systemB] };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB);

    expect(scheduler.getExecutionOrder()).toHaveLength(2);

    scheduler.clear();

    expect(scheduler.getExecutionOrder()).toHaveLength(0);
  });
});
