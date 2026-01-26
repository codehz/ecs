import { describe, expect, it } from "bun:test";
import type { ComponentId, EntityId } from "../core/entity";
import {
  component,
  COMPONENT_ID_MAX,
  ComponentIdAllocator,
  createComponentId,
  createEntityId,
  decodeRelationId,
  ENTITY_ID_START,
  EntityIdManager,
  getComponentIdByName,
  getComponentNameById,
  getComponentOptions,
  getDetailedIdType,
  getIdType,
  inspectEntityId,
  INVALID_COMPONENT_ID,
  isCascadeDeleteComponent,
  isComponentId,
  isDontFragmentComponent,
  isEntityId,
  isExclusiveComponent,
  isRelationId,
  isWildcardRelationId,
  relation,
} from "../core/entity";

describe("Entity ID System", () => {
  describe("Component IDs", () => {
    it("should create valid component IDs", () => {
      expect(createComponentId(1)).toBe(createComponentId(1));
      expect(createComponentId(2)).toBe(createComponentId(2));
      expect(createComponentId(COMPONENT_ID_MAX)).toBe(createComponentId(COMPONENT_ID_MAX));
    });

    it("should reject invalid component IDs", () => {
      expect(() => createComponentId(0)).toThrow();
      expect(() => createComponentId(-1)).toThrow();
      expect(() => createComponentId(COMPONENT_ID_MAX + 1)).toThrow();
    });

    it("should identify component IDs correctly", () => {
      expect(isComponentId(createComponentId(1))).toBe(true);
      expect(isComponentId(createComponentId(2))).toBe(true);
      expect(isComponentId(createComponentId(COMPONENT_ID_MAX))).toBe(true);
      expect(isComponentId(createEntityId(ENTITY_ID_START))).toBe(false);
      expect(isComponentId(relation(createComponentId(1), createEntityId(ENTITY_ID_START)))).toBe(false);
    });
  });

  describe("Entity IDs", () => {
    it("should create valid entity IDs", () => {
      expect(createEntityId(ENTITY_ID_START)).toBe(createEntityId(ENTITY_ID_START));
      expect(createEntityId(ENTITY_ID_START + 1)).toBe(createEntityId(ENTITY_ID_START + 1));
      expect(createEntityId(10000)).toBe(createEntityId(10000));
    });

    it("should reject invalid entity IDs", () => {
      expect(() => createEntityId(ENTITY_ID_START - 1)).toThrow();
      expect(() => createEntityId(0)).toThrow();
    });

    it("should identify entity IDs correctly", () => {
      expect(isEntityId(createEntityId(ENTITY_ID_START))).toBe(true);
      expect(isEntityId(createEntityId(10000))).toBe(true);
      expect(isEntityId(createComponentId(1))).toBe(false);
      expect(isEntityId(relation(createComponentId(1), createEntityId(ENTITY_ID_START)))).toBe(false);
    });
  });

  describe("Relation IDs", () => {
    it("should create valid relation IDs with entities", () => {
      const compId = createComponentId(5);
      const entId = createEntityId(ENTITY_ID_START + 10);
      const relationId = relation(compId, entId);

      expect(relationId).toBeLessThan(0);
      expect(isRelationId(relationId)).toBe(true);
    });

    it("should create valid relation IDs with components", () => {
      const compId1 = createComponentId(5);
      const compId2 = createComponentId(10);
      const relationId = relation(compId1, compId2);

      expect(relationId).toBeLessThan(0);
      expect(isRelationId(relationId)).toBe(true);
    });

    it("should reject invalid relation creation", () => {
      const entId = createEntityId(ENTITY_ID_START);
      expect(() => relation(1024 as ComponentId, entId)).toThrow(); // invalid component id
      expect(() => relation(createComponentId(5), -1 as EntityId)).toThrow(); // invalid target id
      expect(() => relation(createComponentId(5), relation(createComponentId(1), createEntityId(1025)))).toThrow(); // relation as target
    });

    it("should decode relation IDs with entities correctly", () => {
      const compId = createComponentId(42);
      const entId = createEntityId(ENTITY_ID_START + 123);
      const relationId = relation(compId, entId);

      const decoded = decodeRelationId(relationId);
      expect(decoded.componentId).toBe(compId);
      expect(decoded.targetId).toBe(entId);
      expect(decoded.type).toBe("entity");
    });

    it("should decode relation IDs with components correctly", () => {
      const compId1 = createComponentId(42);
      const compId2 = createComponentId(100);
      const relationId = relation(compId1, compId2);

      const decoded = decodeRelationId(relationId);
      expect(decoded.componentId).toBe(compId1);
      expect(decoded.targetId).toBe(compId2);
      expect(decoded.type).toBe("component");
    });

    it("should create valid wildcard relation IDs", () => {
      const compId = createComponentId(5);
      const relationId = relation(compId, "*");

      expect(relationId).toBeLessThan(0);
      expect(isRelationId(relationId)).toBe(true);
    });

    it("should identify wildcard relation IDs correctly", () => {
      const compId = createComponentId(5);
      const wildcardRelationId = relation(compId, "*");
      const entityRelationId = relation(compId, createEntityId(ENTITY_ID_START));
      const componentRelationId = relation(compId, createComponentId(10));
      const entityId = createEntityId(ENTITY_ID_START);
      const componentId = createComponentId(1);

      expect(isWildcardRelationId(wildcardRelationId)).toBe(true);
      expect(isWildcardRelationId(entityRelationId)).toBe(false);
      expect(isWildcardRelationId(componentRelationId)).toBe(false);
      expect(isWildcardRelationId(entityId)).toBe(false);
      expect(isWildcardRelationId(componentId)).toBe(false);
    });

    it("should decode wildcard relation IDs correctly", () => {
      const compId = createComponentId(42);
      const relationId = relation(compId, "*");

      const decoded = decodeRelationId(relationId);
      expect(decoded.componentId).toBe(compId);
      expect(decoded.targetId).toBe(0 as EntityId);
      expect(decoded.type).toBe("wildcard");
    });
  });

  describe("ID Type Detection", () => {
    it("should correctly identify ID types", () => {
      expect(getIdType(createComponentId(1))).toBe("component");
      expect(getIdType(createComponentId(500))).toBe("component");
      expect(getIdType(createEntityId(ENTITY_ID_START))).toBe("entity");
      expect(getIdType(createEntityId(10000))).toBe("entity");
      expect(getIdType(relation(createComponentId(1), createEntityId(ENTITY_ID_START)))).toBe("entity-relation");
      expect(getIdType(relation(createComponentId(1), createComponentId(2)))).toBe("component-relation");
      expect(getIdType(relation(createComponentId(1), "*"))).toBe("wildcard-relation");

      // Invalid IDs
      expect(getIdType(INVALID_COMPONENT_ID as EntityId)).toBe("invalid");
      expect(getIdType(-999999 as EntityId)).toBe("invalid");
    });

    it("should provide detailed ID type information", () => {
      // Component ID
      const compResult = getDetailedIdType(createComponentId(42));
      expect(compResult.type).toBe("component");
      expect(compResult.componentId).toBeUndefined();
      expect(compResult.targetId).toBeUndefined();

      // Entity ID
      const entityResult = getDetailedIdType(createEntityId(ENTITY_ID_START + 100));
      expect(entityResult.type).toBe("entity");
      expect(entityResult.componentId).toBeUndefined();
      expect(entityResult.targetId).toBeUndefined();

      // Entity relation
      const entityRelationId = relation(createComponentId(5), createEntityId(ENTITY_ID_START + 200));
      const entityRelationResult = getDetailedIdType(entityRelationId);
      expect(entityRelationResult.type).toBe("entity-relation");
      expect(entityRelationResult.componentId).toBe(createComponentId(5));
      expect(entityRelationResult.targetId).toBe(createEntityId(ENTITY_ID_START + 200));

      // Component relation
      const compRelationId = relation(createComponentId(10), createComponentId(20));
      const compRelationResult = getDetailedIdType(compRelationId);
      expect(compRelationResult.type).toBe("component-relation");
      expect(compRelationResult.componentId).toBe(createComponentId(10));
      expect(compRelationResult.targetId).toBe(createComponentId(20));

      // Wildcard relation
      const wildcardRelationId = relation(createComponentId(15), "*");
      const wildcardRelationResult = getDetailedIdType(wildcardRelationId);
      expect(wildcardRelationResult.type).toBe("wildcard-relation");
      expect(wildcardRelationResult.componentId).toBe(createComponentId(15));
      expect(wildcardRelationResult.targetId).toBe(0 as EntityId);

      // Invalid IDs
      const invalidResult = getDetailedIdType(INVALID_COMPONENT_ID as EntityId);
      expect(invalidResult.type).toBe("invalid");
      expect(invalidResult.componentId).toBeUndefined();
      expect(invalidResult.targetId).toBeUndefined();

      const invalidRelationResult = getDetailedIdType(-999999 as EntityId);
      expect(invalidRelationResult.type).toBe("invalid");
      expect(invalidRelationResult.componentId).toBeUndefined();
      expect(invalidRelationResult.targetId).toBeUndefined();
    });
  });

  describe("ID Inspection", () => {
    it("should inspect invalid component ID", () => {
      expect(inspectEntityId(INVALID_COMPONENT_ID as EntityId)).toBe("Invalid Component ID (0)");
    });

    it("should inspect component IDs", () => {
      expect(inspectEntityId(createComponentId(1))).toBe("Component ID (1)");
      expect(inspectEntityId(createComponentId(42))).toBe("Component ID (42)");
      expect(inspectEntityId(createComponentId(COMPONENT_ID_MAX))).toBe(`Component ID (${COMPONENT_ID_MAX})`);
    });

    it("should inspect entity IDs", () => {
      expect(inspectEntityId(createEntityId(ENTITY_ID_START))).toBe(`Entity ID (${ENTITY_ID_START})`);
      expect(inspectEntityId(createEntityId(10000))).toBe("Entity ID (10000)");
    });

    it("should inspect relation IDs with entities", () => {
      const compId = createComponentId(5);
      const entId = createEntityId(ENTITY_ID_START + 10);
      const relationId = relation(compId, entId);

      expect(inspectEntityId(relationId)).toBe("Relation ID: Component ID (5) -> Entity ID (1034)");
    });

    it("should inspect relation IDs with components", () => {
      const compId1 = createComponentId(10);
      const compId2 = createComponentId(20);
      const relationId = relation(compId1, compId2);

      expect(inspectEntityId(relationId)).toBe("Relation ID: Component ID (10) -> Component ID (20)");
    });

    it("should handle invalid relation IDs gracefully", () => {
      // Create an invalid relation ID that looks like a relation but has invalid components
      const invalidRelationId = -999999 as EntityId;
      expect(inspectEntityId(invalidRelationId)).toBe("Invalid Relation ID (-999999)");
    });

    it("should inspect wildcard relation IDs", () => {
      const compId = createComponentId(15);
      const relationId = relation(compId, "*");

      expect(inspectEntityId(relationId)).toBe("Relation ID: Component ID (15) -> Wildcard (*)");
    });
  });

  describe("Bit Operations Safety", () => {
    it("should handle large entity IDs within safe integer range", () => {
      // 2^42 - 1 is within safe integer (2^53 - 1)
      const largeEntityId = (1 << 42) - 1 + ENTITY_ID_START;
      expect(Number.isSafeInteger(largeEntityId)).toBe(true);

      const compId = createComponentId(1023);
      const relationId = relation(compId, largeEntityId as EntityId);
      expect(Number.isSafeInteger(relationId)).toBe(true);

      const decoded = decodeRelationId(relationId);
      expect(decoded.componentId).toBe(compId);
      expect(decoded.targetId).toBe(largeEntityId as EntityId);
      expect(decoded.type).toBe("entity");
    });
  });
});

describe("EntityIdManager", () => {
  describe("Allocation", () => {
    it("should allocate sequential entity IDs starting from ENTITY_ID_START", () => {
      const manager = new EntityIdManager();
      expect(manager.allocate()).toBe(createEntityId(ENTITY_ID_START));
      expect(manager.allocate()).toBe(createEntityId(ENTITY_ID_START + 1));
      expect(manager.allocate()).toBe(createEntityId(ENTITY_ID_START + 2));
    });

    it("should reuse IDs from freelist before allocating new ones", () => {
      const manager = new EntityIdManager();
      manager.allocate(); // 1024
      const id2 = manager.allocate(); // 1025
      manager.allocate(); // 1026

      manager.deallocate(id2);
      expect(manager.allocate()).toBe(id2); // Should reuse 1025
      expect(manager.allocate()).toBe(createEntityId(ENTITY_ID_START + 3)); // Then 1027
    });
  });

  describe("Deallocation", () => {
    it("should add deallocated IDs to freelist", () => {
      const manager = new EntityIdManager();
      const id = manager.allocate();
      expect(manager.getFreelistSize()).toBe(0);

      manager.deallocate(id);
      expect(manager.getFreelistSize()).toBe(1);
    });

    it("should reject deallocation of invalid entity IDs", () => {
      const manager = new EntityIdManager();
      expect(() => manager.deallocate(1000 as EntityId)).toThrow(); // Below ENTITY_ID_START
      expect(() => manager.deallocate(createComponentId(5))).toThrow(); // Component ID
      expect(() => manager.deallocate(relation(createComponentId(1), createEntityId(1025)))).toThrow(); // Relation ID
    });

    it("should reject deallocation of unallocated IDs", () => {
      const manager = new EntityIdManager();
      expect(() => manager.deallocate((ENTITY_ID_START + 100) as EntityId)).toThrow();
    });
  });

  describe("Freelist Management", () => {
    it("should maintain correct freelist size", () => {
      const manager = new EntityIdManager();
      const ids: EntityId[] = [];

      // Allocate 5 IDs
      for (let i = 0; i < 5; i++) {
        ids.push(manager.allocate());
      }
      expect(manager.getFreelistSize()).toBe(0);

      // Deallocate 3 IDs
      manager.deallocate(ids[1]!);
      manager.deallocate(ids[3]!);
      manager.deallocate(ids[4]!);
      expect(manager.getFreelistSize()).toBe(3);

      // Allocate 2 more (should reuse)
      manager.allocate(); // Reuse ids[1]
      manager.allocate(); // Reuse ids[3]
      expect(manager.getFreelistSize()).toBe(1); // ids[4] still in freelist
    });

    it("should handle multiple deallocate/allocate cycles", () => {
      const manager = new EntityIdManager();
      const allocated: EntityId[] = [];

      // Allocate 10, deallocate all, allocate 10 again
      for (let i = 0; i < 10; i++) {
        allocated.push(manager.allocate());
      }
      allocated.forEach((id) => manager.deallocate(id));
      expect(manager.getFreelistSize()).toBe(10);

      const newAllocated: EntityId[] = [];
      for (let i = 0; i < 10; i++) {
        newAllocated.push(manager.allocate());
      }
      expect(manager.getFreelistSize()).toBe(0);
      // Should have reused all previous IDs
      expect(new Set(newAllocated)).toEqual(new Set(allocated));
    });
  });

  describe("Overflow Protection", () => {
    it("should throw error on ID overflow", () => {
      const manager = new EntityIdManager();
      // Mock nextId to near max
      (manager as any).nextId = Number.MAX_SAFE_INTEGER - 1;
      (manager as any).freelist.clear();

      expect(() => manager.allocate()).toThrow("Entity ID overflow");
    });
  });
});

describe("ComponentIdManager", () => {
  describe("Allocation", () => {
    it("should allocate sequential component IDs starting from 1", () => {
      const manager = new ComponentIdAllocator();
      expect(manager.allocate()).toBe(createComponentId(1));
      expect(manager.allocate()).toBe(createComponentId(2));
      expect(manager.allocate()).toBe(createComponentId(3));
    });

    it("should allocate up to COMPONENT_ID_MAX", () => {
      const manager = new ComponentIdAllocator();
      for (let i = 1; i <= COMPONENT_ID_MAX; i++) {
        expect(manager.allocate()).toBe(createComponentId(i));
      }
      expect(manager.hasAvailableIds()).toBe(false);
    });

    it("should throw error when exceeding maximum component IDs", () => {
      const manager = new ComponentIdAllocator();
      // Allocate all available IDs
      for (let i = 1; i <= COMPONENT_ID_MAX; i++) {
        manager.allocate();
      }
      expect(() => manager.allocate()).toThrow("Component ID overflow");
    });
  });

  describe("State Queries", () => {
    it("should report correct next ID", () => {
      const manager = new ComponentIdAllocator();
      expect(manager.getNextId()).toBe(1);
      manager.allocate();
      expect(manager.getNextId()).toBe(2);
      manager.allocate();
      expect(manager.getNextId()).toBe(3);
    });

    it("should correctly report available IDs", () => {
      const manager = new ComponentIdAllocator();
      expect(manager.hasAvailableIds()).toBe(true);

      // Allocate all but one
      for (let i = 1; i < COMPONENT_ID_MAX; i++) {
        manager.allocate();
      }
      expect(manager.hasAvailableIds()).toBe(true);

      // Allocate the last one
      manager.allocate();
      expect(manager.hasAvailableIds()).toBe(false);
    });
  });
});

describe("Component Options", () => {
  it("should store and retrieve component options", () => {
    const exclusiveComp = component({ exclusive: true });
    const cascadeComp = component({ cascadeDelete: true });
    const bothComp = component({ exclusive: true, cascadeDelete: true });
    const normalComp = component();

    const exclusiveOpts = getComponentOptions(exclusiveComp);
    expect(exclusiveOpts.exclusive).toBe(true);
    expect(exclusiveOpts.cascadeDelete).toBe(undefined);

    const cascadeOpts = getComponentOptions(cascadeComp);
    expect(cascadeOpts.exclusive).toBe(undefined);
    expect(cascadeOpts.cascadeDelete).toBe(true);

    const bothOpts = getComponentOptions(bothComp);
    expect(bothOpts.exclusive).toBe(true);
    expect(bothOpts.cascadeDelete).toBe(true);

    const normalOpts = getComponentOptions(normalComp);
    expect(normalOpts.name).toBe(undefined);
    expect(normalOpts.exclusive).toBe(undefined);
    expect(normalOpts.cascadeDelete).toBe(undefined);
    expect(normalOpts.dontFragment).toBe(undefined);
  });

  it("should support name in options object", () => {
    const namedComp = component({ name: "TestComponent", exclusive: true });

    const options = getComponentOptions(namedComp);
    expect(options?.name).toBe("TestComponent");
    expect(options?.exclusive).toBe(true);

    expect(getComponentNameById(namedComp)).toBe("TestComponent");
    expect(getComponentIdByName("TestComponent")).toBe(namedComp);
  });

  it("should check if component is exclusive", () => {
    const exclusiveComp = component({ exclusive: true });
    const normalComp = component();

    expect(isExclusiveComponent(exclusiveComp)).toBe(true);
    expect(isExclusiveComponent(normalComp)).toBe(false);
  });

  it("should check if component is cascade delete", () => {
    const cascadeComp = component({ cascadeDelete: true });
    const normalComp = component();

    expect(isCascadeDeleteComponent(cascadeComp)).toBe(true);
    expect(isCascadeDeleteComponent(normalComp)).toBe(false);
  });

  it("should check if component is dontFragment", () => {
    const dontFragmentComp = component({ dontFragment: true });
    const normalComp = component();

    expect(isDontFragmentComponent(dontFragmentComp)).toBe(true);
    expect(isDontFragmentComponent(normalComp)).toBe(false);
  });

  it("should support cascadeDelete and dontFragment set simultaneously", () => {
    const combinedComp = component({ cascadeDelete: true, dontFragment: true });

    const options = getComponentOptions(combinedComp);
    expect(options.cascadeDelete).toBe(true);
    expect(options.dontFragment).toBe(true);

    expect(isCascadeDeleteComponent(combinedComp)).toBe(true);
    expect(isDontFragmentComponent(combinedComp)).toBe(true);
  });

  it("should throw error for invalid component ID", () => {
    expect(() => getComponentOptions(0 as ComponentId)).toThrow("Invalid component ID");
    expect(() => getComponentOptions(1025 as ComponentId)).toThrow("Invalid component ID");
    expect(() => getComponentOptions(-1 as ComponentId)).toThrow("Invalid component ID");
  });
});
