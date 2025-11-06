import type { System } from "./system";

/**
 * System Scheduler for managing system dependencies and execution order
 */
export class SystemScheduler<UpdateParams extends any[] = []> {
  private systems = new Set<System<UpdateParams>>();
  private systemDependencies = new Map<System<UpdateParams>, Set<System<UpdateParams>>>();
  private cachedExecutionOrder: System<UpdateParams>[] | null = null;

  /**
   * Add a system with optional dependencies
   * @param system The system to add
   * @param additionalDeps Additional dependencies for the system
   */
  addSystem(system: System<UpdateParams>, additionalDeps: System<UpdateParams>[] = []): void {
    this.systems.add(system);
    // Also add dependencies to the set
    for (const dep of system.dependencies || []) {
      this.systems.add(dep);
    }
    this.systemDependencies.set(system, new Set([...additionalDeps, ...(system.dependencies || [])]));
    this.cachedExecutionOrder = null;
  }

  /**
   * Get the execution order of systems based on dependencies
   * Uses topological sort
   */
  getExecutionOrder(): System<UpdateParams>[] {
    if (this.cachedExecutionOrder !== null) {
      return this.cachedExecutionOrder;
    }

    const result: System<UpdateParams>[] = [];
    const visited = new Set<System<UpdateParams>>();
    const visiting = new Set<System<UpdateParams>>();

    const visit = (system: System<UpdateParams>): void => {
      if (visited.has(system)) return;
      if (visiting.has(system)) {
        throw new Error("Circular dependency detected in system scheduling");
      }

      visiting.add(system);

      for (const dep of this.systemDependencies.get(system) || []) {
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

  async update(...params: UpdateParams): Promise<void> {
    const executionOrder = this.getExecutionOrder();
    const systemPromises = new Map<System<UpdateParams>, Promise<void>>();

    for (const system of executionOrder) {
      const deps = Array.from(this.systemDependencies.get(system) || []);
      const depPromises = deps.map((dep) => systemPromises.get(dep)!);

      const promise = Promise.all(depPromises).then(() => system.update(...params));
      systemPromises.set(system, promise);
    }

    await Promise.all(systemPromises.values());
  }

  /**
   * Clear all systems and dependencies
   */
  clear(): void {
    this.systems.clear();
    this.cachedExecutionOrder = null;
  }
}
