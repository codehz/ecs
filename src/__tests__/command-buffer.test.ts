import { describe, expect, it } from "bun:test";
import { CommandBuffer, type Command } from "../commands/command-buffer";
import type { EntityId } from "../core/entity";

describe("CommandBuffer", () => {
  it("should buffer commands and execute them", () => {
    const executedCommands: { entityId: EntityId; commands: Command[] }[] = [];

    const mockExecutor = (entityId: EntityId, commands: Command[]) => {
      executedCommands.push({ entityId, commands });
    };

    const buffer = new CommandBuffer(mockExecutor);

    // Create mock entity IDs
    const entity1 = 1 as EntityId;
    const entity2 = 2 as EntityId;
    const componentType1 = 100 as EntityId<any>;
    const componentType2 = 200 as EntityId<any>;

    // Add commands
    buffer.set(entity1, componentType1, { x: 1 });
    buffer.set(entity1, componentType2, { y: 2 });
    buffer.remove(entity2, componentType1);

    // Execute
    buffer.execute();

    // Verify execution
    expect(executedCommands).toHaveLength(2);

    // Check entity1 commands
    const entity1Execution = executedCommands.find((e) => e.entityId === entity1);
    expect(entity1Execution).toBeDefined();
    if (entity1Execution) {
      expect(entity1Execution.commands).toHaveLength(2);
      expect(entity1Execution.commands[0]!.type).toBe("set");
      expect(entity1Execution.commands[1]!.type).toBe("set");
    }

    // Check entity2 commands
    const entity2Execution = executedCommands.find((e) => e.entityId === entity2);
    expect(entity2Execution).toBeDefined();
    if (entity2Execution) {
      expect(entity2Execution.commands).toHaveLength(1);
      expect(entity2Execution.commands[0]!.type).toBe("delete");
    }

    // Verify buffer is cleared
    expect(buffer.getCommands()).toHaveLength(0);
  });

  it("should handle destroy commands", () => {
    const executedCommands: { entityId: EntityId; commands: Command[] }[] = [];

    const mockExecutor = (entityId: EntityId, commands: Command[]) => {
      executedCommands.push({ entityId, commands });
    };

    const buffer = new CommandBuffer(mockExecutor);

    const entity = 1 as EntityId;
    const componentType = 100 as EntityId<any>;

    // Add commands including destroy
    buffer.set(entity, componentType, { x: 1 });
    buffer.delete(entity);

    buffer.execute();

    // Should still execute (destroy logic is handled in the executor)
    expect(executedCommands).toHaveLength(1);
    const execution = executedCommands[0]!;
    expect(execution.entityId).toBe(entity);
    expect(execution.commands).toHaveLength(2);
  });

  it("should clear commands after execution", () => {
    const mockExecutor = () => {};
    const buffer = new CommandBuffer(mockExecutor);

    const entity = 1 as EntityId;
    const componentType = 100 as EntityId<any>;

    buffer.set(entity, componentType, { x: 1 });
    expect(buffer.getCommands()).toHaveLength(1);

    buffer.execute();
    expect(buffer.getCommands()).toHaveLength(0);
  });

  it("should allow manual clearing", () => {
    const mockExecutor = () => {};
    const buffer = new CommandBuffer(mockExecutor);

    const entity = 1 as EntityId;
    const componentType = 100 as EntityId<any>;

    buffer.set(entity, componentType, { x: 1 });
    expect(buffer.getCommands()).toHaveLength(1);

    buffer.clear();
    expect(buffer.getCommands()).toHaveLength(0);
  });

  it("should execute commands added during execution until queue is empty", () => {
    const executedCommands: { entityId: EntityId; commands: Command[] }[] = [];

    let bufferRef: CommandBuffer;
    const mockExecutor = (entityId: EntityId, commands: Command[]) => {
      executedCommands.push({ entityId, commands });

      // If this is the first execution, add more commands
      if (executedCommands.length === 1) {
        const newEntity = 3 as EntityId;
        const newComponentType = 300 as EntityId<any>;
        bufferRef.set(newEntity, newComponentType, { z: 3 });
      }
    };

    const buffer = new CommandBuffer(mockExecutor);
    bufferRef = buffer;

    const entity1 = 1 as EntityId;
    const entity2 = 2 as EntityId;
    const componentType1 = 100 as EntityId<any>;
    const componentType2 = 200 as EntityId<any>;

    // Add initial commands
    buffer.set(entity1, componentType1, { x: 1 });
    buffer.set(entity2, componentType2, { y: 2 });

    // Execute
    buffer.execute();

    // Should have executed three times: entity1, entity2, and the new entity3
    expect(executedCommands).toHaveLength(3);

    // First execution: entity1
    const entity1Execution = executedCommands.find((e) => e.entityId === entity1);
    expect(entity1Execution).toBeDefined();
    if (entity1Execution) {
      expect(entity1Execution.commands).toHaveLength(1);
      expect(entity1Execution.commands[0]!.type).toBe("set");
    }

    // Second execution: entity2
    const entity2Execution = executedCommands.find((e) => e.entityId === entity2);
    expect(entity2Execution).toBeDefined();
    if (entity2Execution) {
      expect(entity2Execution.commands).toHaveLength(1);
      expect(entity2Execution.commands[0]!.type).toBe("set");
    }

    // Third execution: new entity
    const entity3Execution = executedCommands.find((e) => e.entityId === (3 as EntityId));
    expect(entity3Execution).toBeDefined();
    if (entity3Execution) {
      expect(entity3Execution.commands).toHaveLength(1);
      expect(entity3Execution.commands[0]!.type).toBe("set");
    }

    // Buffer should be empty
    expect(buffer.getCommands()).toHaveLength(0);
  });

  it("should throw error on infinite loop detection", () => {
    const executedCommands: { entityId: EntityId; commands: Command[] }[] = [];

    let bufferRef: CommandBuffer;
    const mockExecutor = (entityId: EntityId, commands: Command[]) => {
      executedCommands.push({ entityId, commands });

      // Always add more commands to create infinite loop
      const newEntity = (entityId + 1) as EntityId;
      const newComponentType = 100 as EntityId<any>;
      bufferRef.set(newEntity, newComponentType, { value: entityId });
    };

    const buffer = new CommandBuffer(mockExecutor);
    bufferRef = buffer;

    const entity = 1 as EntityId;
    const componentType = 100 as EntityId<any>;

    // Add initial command
    buffer.set(entity, componentType, { x: 1 });

    // Execute should throw error due to infinite loop
    expect(() => buffer.execute()).toThrow("Command execution exceeded maximum iterations, possible infinite loop");

    // Should have executed many times (up to MAX_ITERATIONS)
    expect(executedCommands.length).toBeGreaterThan(0);
  });
});
