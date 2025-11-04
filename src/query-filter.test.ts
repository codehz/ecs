import { describe, it, expect } from "bun:test";
import { Archetype } from "./archetype";
import type { EntityId } from "./entity";
import { createRelationId } from "./entity";
import { matchesComponentTypes, matchesFilter, type QueryFilter } from "./query-filter";

// Mock component IDs for testing
const positionComponent = 1 as EntityId<{ x: number; y: number }>;
const velocityComponent = 2 as EntityId<{ dx: number; dy: number }>;
const healthComponent = 3 as EntityId<{ value: number }>;
const relationComponent = 4 as EntityId<{ strength: number }>;

describe("Query Filter Functions", () => {
  describe("matchesComponentTypes", () => {
    it("should return true when archetype contains all required component types", () => {
      const archetype = new Archetype([positionComponent, velocityComponent]);
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });

    it("should return true when archetype contains required component types and more", () => {
      const archetype = new Archetype([positionComponent, velocityComponent, healthComponent]);
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });

    it("should return false when archetype is missing a required component type", () => {
      const archetype = new Archetype([positionComponent]);
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(false);
    });

    it("should return true for empty component types array", () => {
      const archetype = new Archetype([positionComponent]);
      const componentTypes: EntityId<any>[] = [];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });
  });

  describe("matchesFilter", () => {
    it("should return true when no negative component types are specified", () => {
      const archetype = new Archetype([positionComponent, velocityComponent]);
      const filter: QueryFilter = {};
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return true when archetype does not contain any negative component types", () => {
      const archetype = new Archetype([positionComponent, velocityComponent]);
      const filter: QueryFilter = { negativeComponentTypes: [healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains a negative component type", () => {
      const archetype = new Archetype([positionComponent, velocityComponent, healthComponent]);
      const filter: QueryFilter = { negativeComponentTypes: [healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return false when archetype contains any of multiple negative component types", () => {
      const archetype = new Archetype([positionComponent, healthComponent]);
      const filter: QueryFilter = { negativeComponentTypes: [velocityComponent, healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return true when archetype contains none of multiple negative component types", () => {
      const archetype = new Archetype([positionComponent]);
      const filter: QueryFilter = { negativeComponentTypes: [velocityComponent, healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains a negative wildcard relation component", () => {
      const wildcardRelation = createRelationId(relationComponent, "*");
      const archetype = new Archetype([positionComponent, wildcardRelation]);
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return false when archetype contains a specific relation matching negative wildcard filter", () => {
      const wildcardRelation = createRelationId(relationComponent, "*");
      const otherRelation = createRelationId(relationComponent, 1025 as EntityId);
      const archetype = new Archetype([positionComponent, otherRelation]);
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return true when archetype does not contain any relations with the wildcard component", () => {
      const wildcardRelation = createRelationId(relationComponent, "*");
      const otherComponent = 5 as EntityId<{ other: number }>;
      const archetype = new Archetype([positionComponent, otherComponent]);
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains wildcard relation matching negative filter", () => {
      const wildcardRelation = createRelationId(relationComponent, "*");
      const matchingRelation = createRelationId(relationComponent, 1026 as EntityId);
      const archetype = new Archetype([positionComponent, matchingRelation]);
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });
  });
});
