import { describe, expect, it } from "bun:test";
import type { ComponentId, EntityId } from "../../entity";
import {
  COMPONENT_ID_MAX,
  createComponentId,
  createEntityId,
  decodeRelationId,
  ENTITY_ID_START,
  getDetailedIdType,
  getIdType,
  inspectEntityId,
  INVALID_COMPONENT_ID,
  isComponentId,
  isEntityId,
  isRelationId,
  isWildcardRelationId,
  relation,
} from "../../entity";

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
      expect(() => relation(1024 as ComponentId, entId)).toThrow();
      expect(() => relation(createComponentId(5), -1 as EntityId)).toThrow();
      expect(() => relation(createComponentId(5), relation(createComponentId(1), createEntityId(1025)))).toThrow();
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

      expect(getIdType(INVALID_COMPONENT_ID as EntityId)).toBe("invalid");
      expect(getIdType(-999999 as EntityId)).toBe("invalid");
    });

    it("should provide detailed ID type information", () => {
      const compResult = getDetailedIdType(createComponentId(42));
      expect(compResult.type).toBe("component");
      expect(compResult.componentId).toBeUndefined();
      expect(compResult.targetId).toBeUndefined();

      const entityResult = getDetailedIdType(createEntityId(ENTITY_ID_START + 100));
      expect(entityResult.type).toBe("entity");
      expect(entityResult.componentId).toBeUndefined();
      expect(entityResult.targetId).toBeUndefined();

      const entityRelationId = relation(createComponentId(5), createEntityId(ENTITY_ID_START + 200));
      const entityRelationResult = getDetailedIdType(entityRelationId);
      expect(entityRelationResult.type).toBe("entity-relation");
      expect(entityRelationResult.componentId).toBe(createComponentId(5));
      expect(entityRelationResult.targetId).toBe(createEntityId(ENTITY_ID_START + 200));

      const compRelationId = relation(createComponentId(10), createComponentId(20));
      const compRelationResult = getDetailedIdType(compRelationId);
      expect(compRelationResult.type).toBe("component-relation");
      expect(compRelationResult.componentId).toBe(createComponentId(10));
      expect(compRelationResult.targetId).toBe(createComponentId(20));

      const wildcardRelationId = relation(createComponentId(15), "*");
      const wildcardRelationResult = getDetailedIdType(wildcardRelationId);
      expect(wildcardRelationResult.type).toBe("wildcard-relation");
      expect(wildcardRelationResult.componentId).toBe(createComponentId(15));
      expect(wildcardRelationResult.targetId).toBe(0 as EntityId);

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
