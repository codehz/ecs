import type { EntityId } from "../entity";

/**
 * Maximum number of command buffer execution iterations to prevent infinite loops
 */
const MAX_COMMAND_ITERATIONS = 100;

/**
 * Command for deferred execution
 * Uses discriminated union for type safety
 */
export type Command =
  | { type: "set"; entityId: EntityId; componentType: EntityId<any>; component: any }
  | { type: "delete"; entityId: EntityId; componentType: EntityId<any> }
  | { type: "destroy"; entityId: EntityId };

/**
 * Command buffer for deferred structural changes
 */
export class CommandBuffer {
  private commands: Command[] = [];
  private swapBuffer: Command[] = [];
  /** Reusable map to group commands by entity, avoids per-sync allocations */
  private entityCommands: Map<EntityId, Command[]> = new Map();
  /**
   * Pool of command arrays recycled across sync iterations.
   * Avoids allocating a fresh `Command[]` per entity on every execute().
   */
  private commandArrayPool: Command[][] = [];
  private executeEntityCommands: (entityId: EntityId, commands: Command[]) => void;

  /**
   * Create a command buffer with an executor function
   */
  constructor(executeEntityCommands: (entityId: EntityId, commands: Command[]) => void) {
    this.executeEntityCommands = executeEntityCommands;
  }

  private acquireCommandArray(): Command[] {
    const pooled = this.commandArrayPool.pop();
    if (pooled !== undefined) {
      pooled.length = 0;
      return pooled;
    }
    return [];
  }

  /**
   * Add a component to an entity (deferred)
   */
  set(entityId: EntityId, componentType: EntityId<void>): void;
  set<T>(entityId: EntityId, componentType: EntityId<T>, component: NoInfer<T>): void;
  set(entityId: EntityId, componentType: EntityId, component?: any): void {
    this.commands.push({ type: "set", entityId, componentType, component });
  }

  /**
   * Remove a component from an entity (deferred)
   */
  remove<T>(entityId: EntityId, componentType: EntityId<T>): void {
    this.commands.push({ type: "delete", entityId, componentType });
  }

  /**
   * Destroy an entity (deferred)
   */
  delete(entityId: EntityId): void {
    this.commands.push({ type: "destroy", entityId });
  }

  /**
   * Execute all commands and clear the buffer.
   * Returns the number of iterations performed (for debug stats).
   */
  execute(): number {
    let iterations = 0;

    while (this.commands.length > 0) {
      if (iterations >= MAX_COMMAND_ITERATIONS) {
        throw new Error("Command execution exceeded maximum iterations, possible infinite loop");
      }
      iterations++;

      // Swap buffers to avoid allocation
      const currentCommands = this.commands;
      this.commands = this.swapBuffer;

      // Group commands by entity, reusing the persistent Map + pooled arrays
      const entityCommands = this.entityCommands;
      const pool = this.commandArrayPool;
      for (const cmd of currentCommands) {
        const existing = entityCommands.get(cmd.entityId);
        if (existing !== undefined) {
          existing.push(cmd);
        } else {
          const bucket = this.acquireCommandArray();
          bucket.push(cmd);
          entityCommands.set(cmd.entityId, bucket);
        }
      }

      // Clear the consumed buffer for reuse
      currentCommands.length = 0;
      this.swapBuffer = currentCommands;

      // Process each entity's commands, then recycle the per-entity arrays.
      // Arrays are cleared on re-acquire (not here) so a synchronous executor
      // that inspects `commands` after return still sees valid contents for this tick.
      for (const [entityId, commands] of entityCommands) {
        this.executeEntityCommands(entityId, commands);
        pool.push(commands);
      }
      entityCommands.clear();
    }

    return iterations;
  }

  /**
   * Get current commands (for testing)
   */
  getCommands(): Command[] {
    return [...this.commands];
  }

  /**
   * Clear all commands
   */
  clear(): void {
    this.commands = [];
  }
}
