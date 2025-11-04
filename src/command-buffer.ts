import type { EntityId } from "./entity";

/**
 * Command for deferred execution
 */
export interface Command {
  type: "addComponent" | "removeComponent" | "destroyEntity";
  entityId: EntityId;
  componentType?: EntityId<any>;
  component?: any;
}

/**
 * Command buffer for deferred structural changes
 */
export class CommandBuffer {
  private commands: Command[] = [];
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
  addComponent<T>(entityId: EntityId, componentType: EntityId<T>, component: T): void {
    this.commands.push({ type: "addComponent", entityId, componentType, component });
  }

  /**
   * Remove a component from an entity (deferred)
   */
  removeComponent<T>(entityId: EntityId, componentType: EntityId<T>): void {
    this.commands.push({ type: "removeComponent", entityId, componentType });
  }

  /**
   * Destroy an entity (deferred)
   */
  destroyEntity(entityId: EntityId): void {
    this.commands.push({ type: "destroyEntity", entityId });
  }

  /**
   * Execute all commands and clear the buffer
   */
  execute(): void {
    const MAX_ITERATIONS = 100;
    let iterations = 0;

    while (this.commands.length > 0) {
      if (iterations >= MAX_ITERATIONS) {
        throw new Error("Command execution exceeded maximum iterations, possible infinite loop");
      }
      iterations++;

      const currentCommands = [...this.commands];
      this.commands = [];

      // Group commands by entity
      const entityCommands = new Map<EntityId, Command[]>();
      for (const cmd of currentCommands) {
        if (!entityCommands.has(cmd.entityId)) {
          entityCommands.set(cmd.entityId, []);
        }
        entityCommands.get(cmd.entityId)!.push(cmd);
      }

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
