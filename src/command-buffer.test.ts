import { describe, expect, it } from "bun:test";
import { CommandBuffer, type Command } from "./command-buffer";
import type { EntityId } from "./entity";

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
    buffer.addComponent(entity1, componentType1, { x: 1 });
    buffer.addComponent(entity1, componentType2, { y: 2 });
    buffer.removeComponent(entity2, componentType1);

    // Execute
    buffer.execute();

    // Verify execution
    expect(executedCommands).toHaveLength(2);

    // Check entity1 commands
    const entity1Execution = executedCommands.find((e) => e.entityId === entity1);
    expect(entity1Execution).toBeDefined();
    if (entity1Execution) {
      expect(entity1Execution.commands).toHaveLength(2);
      expect(entity1Execution.commands[0]!.type).toBe("addComponent");
      expect(entity1Execution.commands[1]!.type).toBe("addComponent");
    }

    // Check entity2 commands
    const entity2Execution = executedCommands.find((e) => e.entityId === entity2);
    expect(entity2Execution).toBeDefined();
    if (entity2Execution) {
      expect(entity2Execution.commands).toHaveLength(1);
      expect(entity2Execution.commands[0]!.type).toBe("removeComponent");
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
    buffer.addComponent(entity, componentType, { x: 1 });
    buffer.destroyEntity(entity);

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

    buffer.addComponent(entity, componentType, { x: 1 });
    expect(buffer.getCommands()).toHaveLength(1);

    buffer.execute();
    expect(buffer.getCommands()).toHaveLength(0);
  });

  it("should allow manual clearing", () => {
    const mockExecutor = () => {};
    const buffer = new CommandBuffer(mockExecutor);

    const entity = 1 as EntityId;
    const componentType = 100 as EntityId<any>;

    buffer.addComponent(entity, componentType, { x: 1 });
    expect(buffer.getCommands()).toHaveLength(1);

    buffer.clear();
    expect(buffer.getCommands()).toHaveLength(0);
  });
});
