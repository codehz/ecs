import type { EntityId } from "../core/entity";

/**
 * Maximum number of command buffer execution iterations to prevent infinite loops
 */
const MAX_COMMAND_ITERATIONS = 100;

/**
 * Command for deferred execution
 */
export interface Command {
  type: "set" | "delete" | "destroy";
  entityId: EntityId;
  componentType?: EntityId<any>;
  component?: any;
}

/**
 * Command buffer for deferred structural changes
 */
export class CommandBuffer {
  private commands: Command[] = [];
  private swapBuffer: Command[] = [];
  private executeEntityCommands: (entityId: EntityId, commands: Command[]) => void;

  /**
   * Create a command buffer with an executor function
   */
  constructor(executeEntityCommands: (entityId: EntityId, commands: Command[]) => void) {
    this.executeEntityCommands = executeEntityCommands;
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
   * Execute all commands and clear the buffer
   */
  execute(): void {
    let iterations = 0;

    while (this.commands.length > 0) {
      if (iterations >= MAX_COMMAND_ITERATIONS) {
        throw new Error("Command execution exceeded maximum iterations, possible infinite loop");
      }
      iterations++;

      // Swap buffers to avoid allocation
      const currentCommands = this.commands;
      this.commands = this.swapBuffer;

      // Group commands by entity
      const entityCommands = new Map<EntityId, Command[]>();
      for (const cmd of currentCommands) {
        if (!entityCommands.has(cmd.entityId)) {
          entityCommands.set(cmd.entityId, []);
        }
        entityCommands.get(cmd.entityId)!.push(cmd);
      }

      // Clear the consumed buffer for reuse
      currentCommands.length = 0;
      this.swapBuffer = currentCommands;

      // Process each entity's commands with optimization
      for (const [entityId, commands] of entityCommands) {
        this.executeEntityCommands(entityId, commands);
      }
    }
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
