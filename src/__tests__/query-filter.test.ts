import { describe, expect, it } from "bun:test";
import { Archetype } from "../archetype";
import type { ComponentId, EntityId } from "../entity";
import { relation } from "../entity";
import { matchesComponentTypes, matchesFilter, type QueryFilter } from "../query-filter";

// Mock component IDs for testing
const positionComponent = 1 as ComponentId<{ x: number; y: number }>;
const velocityComponent = 2 as ComponentId<{ dx: number; dy: number }>;
const healthComponent = 3 as ComponentId<{ value: number }>;
const relationComponent = 4 as ComponentId<{ strength: number }>;

// Helper function to create a dontFragmentRelations map for testing
const createDontFragmentRelations = () => new Map<EntityId, Map<EntityId<any>, any>>();

describe("Query Filter Functions", () => {
  describe("matchesComponentTypes", () => {
    it("should return true when archetype contains all required component types", () => {
      const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });

    it("should return true when archetype contains required component types and more", () => {
      const archetype = new Archetype(
        [positionComponent, velocityComponent, healthComponent],
        createDontFragmentRelations(),
      );
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });

    it("should return false when archetype is missing a required component type", () => {
      const archetype = new Archetype([positionComponent], createDontFragmentRelations());
      const componentTypes = [positionComponent, velocityComponent];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(false);
    });

    it("should return true for empty component types array", () => {
      const archetype = new Archetype([positionComponent], createDontFragmentRelations());
      const componentTypes: EntityId<any>[] = [];
      expect(matchesComponentTypes(archetype, componentTypes)).toBe(true);
    });
  });

  describe("matchesFilter", () => {
    it("should return true when no negative component types are specified", () => {
      const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
      const filter: QueryFilter = {};
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return true when archetype does not contain any negative component types", () => {
      const archetype = new Archetype([positionComponent, velocityComponent], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains a negative component type", () => {
      const archetype = new Archetype(
        [positionComponent, velocityComponent, healthComponent],
        createDontFragmentRelations(),
      );
      const filter: QueryFilter = { negativeComponentTypes: [healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return false when archetype contains any of multiple negative component types", () => {
      const archetype = new Archetype([positionComponent, healthComponent], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [velocityComponent, healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return true when archetype contains none of multiple negative component types", () => {
      const archetype = new Archetype([positionComponent], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [velocityComponent, healthComponent] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains a negative wildcard relation component", () => {
      const wildcardRelation = relation(relationComponent, "*");
      const archetype = new Archetype([positionComponent, wildcardRelation], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return false when archetype contains a specific relation matching negative wildcard filter", () => {
      const wildcardRelation = relation(relationComponent, "*");
      const otherRelation = relation(relationComponent, 1025 as EntityId);
      const archetype = new Archetype([positionComponent, otherRelation], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });

    it("should return true when archetype does not contain any relations with the wildcard component", () => {
      const wildcardRelation = relation(relationComponent, "*");
      const otherComponent = 5 as EntityId<{ other: number }>;
      const archetype = new Archetype([positionComponent, otherComponent], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(true);
    });

    it("should return false when archetype contains wildcard relation matching negative filter", () => {
      const wildcardRelation = relation(relationComponent, "*");
      const matchingRelation = relation(relationComponent, 1026 as EntityId);
      const archetype = new Archetype([positionComponent, matchingRelation], createDontFragmentRelations());
      const filter: QueryFilter = { negativeComponentTypes: [wildcardRelation] };
      expect(matchesFilter(archetype, filter)).toBe(false);
    });
  });
});
