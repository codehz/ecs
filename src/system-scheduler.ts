import type { System } from "./system";

/**
 * System Scheduler for managing system dependencies and execution order
 */
export class SystemScheduler<ExtraParams extends any[] = [deltaTime: number]> {
  private systems = new Map<System<ExtraParams>, System<ExtraParams>[]>();
  private allSystems = new Set<System<ExtraParams>>();

  /**
   * Add a system with optional dependencies
   * @param system The system to add
   * @param dependencies Systems that this system depends on (must run before this system)
   */
  addSystem(system: System<ExtraParams>, dependencies: System<ExtraParams>[] = []): void {
    this.systems.set(system, dependencies);
    this.allSystems.add(system);
    // Also add dependencies to the set
    for (const dep of dependencies) {
      this.allSystems.add(dep);
    }
  }

  /**
   * Remove a system
   * @param system The system to remove
   */
  removeSystem(system: System<ExtraParams>): void {
    this.systems.delete(system);
    this.allSystems.delete(system);

    // Remove this system from all dependency lists
    for (const [sys, deps] of this.systems) {
      const index = deps.indexOf(system);
      if (index !== -1) {
        deps.splice(index, 1);
      }
    }
  }

  /**
   * Get the execution order of systems based on dependencies
   * Uses topological sort
   */
  getExecutionOrder(): System<ExtraParams>[] {
    const result: System<ExtraParams>[] = [];
    const visited = new Set<System<ExtraParams>>();
    const visiting = new Set<System<ExtraParams>>();

    const visit = (system: System<ExtraParams>): void => {
      if (visited.has(system)) return;
      if (visiting.has(system)) {
        throw new Error("Circular dependency detected in system scheduling");
      }

      visiting.add(system);

      const dependencies = this.systems.get(system) || [];
      for (const dep of dependencies) {
        visit(dep);
      }

      visiting.delete(system);
      visited.add(system);
      result.push(system);
    };

    for (const system of this.allSystems) {
      if (!visited.has(system)) {
        visit(system);
      }
    }

    return result;
  }

  /**
   * Clear all systems and dependencies
   */
  clear(): void {
    this.systems.clear();
    this.allSystems.clear();
  }
}
