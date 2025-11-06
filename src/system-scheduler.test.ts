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

  it("should execute independent systems in parallel", async () => {
    const scheduler = new SystemScheduler();
    const executionOrder: string[] = [];

    const systemA: System = {
      update: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionOrder.push("A");
      },
    };
    const systemB: System = {
      update: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionOrder.push("B");
      },
    };
    const systemC: System = {
      update: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionOrder.push("C");
      },
      dependencies: [systemA],
    };

    scheduler.addSystem(systemA);
    scheduler.addSystem(systemB);
    scheduler.addSystem(systemC);

    const start = Date.now();
    await scheduler.update();
    const duration = Date.now() - start;

    // A and B should execute in parallel (100ms), C after A (100ms), total ~200ms
    // Sequential would be ~300ms
    expect(duration).toBeLessThan(250); // Allow some margin

    // Execution order should have A and B in some order, then C
    expect(executionOrder).toContain("A");
    expect(executionOrder).toContain("B");
    expect(executionOrder).toContain("C");
    expect(executionOrder.indexOf("C")).toBeGreaterThan(executionOrder.indexOf("A"));
  });
});
