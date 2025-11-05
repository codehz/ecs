import type { System } from "./system";

/**
 * System Scheduler for managing system dependencies and execution order
 */
export class SystemScheduler<ExtraParams extends any[] = [deltaTime: number]> {
  private systems = new Set<System<ExtraParams>>();
  private cachedExecutionOrder: System<ExtraParams>[] | null = null;

  /**
   * Add a system with optional dependencies
   * @param system The system to add
   */
  addSystem(system: System<ExtraParams>): void {
    this.systems.add(system);
    // Also add dependencies to the set
    for (const dep of system.dependencies || []) {
      this.systems.add(dep);
    }
    this.cachedExecutionOrder = null;
  }

  /**
   * Get the execution order of systems based on dependencies
   * Uses topological sort
   */
  getExecutionOrder(): System<ExtraParams>[] {
    if (this.cachedExecutionOrder !== null) {
      return this.cachedExecutionOrder;
    }

    const result: System<ExtraParams>[] = [];
    const visited = new Set<System<ExtraParams>>();
    const visiting = new Set<System<ExtraParams>>();

    const visit = (system: System<ExtraParams>): void => {
      if (visited.has(system)) return;
      if (visiting.has(system)) {
        throw new Error("Circular dependency detected in system scheduling");
      }

      visiting.add(system);

      for (const dep of system.dependencies || []) {
        visit(dep);
      }

      visiting.delete(system);
      visited.add(system);
      result.push(system);
    };

    for (const system of this.systems) {
      if (!visited.has(system)) {
        visit(system);
      }
    }

    this.cachedExecutionOrder = result;
    return result;
  }

  /**
   * Clear all systems and dependencies
   */
  clear(): void {
    this.systems.clear();
    this.cachedExecutionOrder = null;
  }
}
