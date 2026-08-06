import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import {
  COMPONENT_ID_MAX,
  ENTITY_ID_START,
  createComponentId,
  createEntityId,
  decodeRelationId,
  decodeRelationRaw,
  getComponentIdFromRelationId,
  getDetailedIdType,
  getIdType,
  getTargetIdFromRelationId,
  isAnyRelation,
  isComponentId,
  isComponentRelation,
  isEntityId,
  isEntityRelation,
  isRelationId,
  isWildcardRelationId,
  relation,
  type ComponentId,
  type EntityId,
} from "../../entity";
import { pbtAssertOptions } from "./config";

const componentIdArb = fc.integer({ min: 1, max: COMPONENT_ID_MAX }).map((id) => createComponentId(id));
const entityIdArb = fc.integer({ min: ENTITY_ID_START, max: ENTITY_ID_START + 50_000 }).map((id) => createEntityId(id));
const targetArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant("*" as const) },
  { weight: 2, arbitrary: componentIdArb },
  { weight: 4, arbitrary: entityIdArb },
);

describe("PBT: relation ID encode/decode", () => {
  it("relation → decodeRelationId is a round-trip", () => {
    fc.assert(
      fc.property(componentIdArb, targetArb, (comp, target) => {
        const id = relation(comp, target as any);
        expect(isRelationId(id)).toBe(true);
        expect(isAnyRelation(id)).toBe(true);
        expect(id).toBeLessThan(0);

        const decoded = decodeRelationId(id as any);
        expect(decoded.componentId).toBe(comp);

        if (target === "*") {
          expect(decoded.type).toBe("wildcard");
          expect(decoded.targetId).toBe(0 as EntityId);
          expect(isWildcardRelationId(id)).toBe(true);
          expect(getTargetIdFromRelationId(id)).toBe(0 as EntityId);
        } else if (isEntityId(target as EntityId)) {
          expect(decoded.type).toBe("entity");
          expect(decoded.targetId).toBe(target);
          expect(isEntityRelation(id)).toBe(true);
          expect(isWildcardRelationId(id)).toBe(false);
          expect(getTargetIdFromRelationId(id)).toBe(target);
        } else {
          expect(decoded.type).toBe("component");
          expect(decoded.targetId).toBe(target);
          expect(isComponentRelation(id)).toBe(true);
          expect(isWildcardRelationId(id)).toBe(false);
          expect(getTargetIdFromRelationId(id)).toBe(target);
        }

        expect(getComponentIdFromRelationId(id)).toBe(comp);

        // Re-encode with decoded pieces must be identical
        const reencoded =
          decoded.type === "wildcard"
            ? relation(decoded.componentId, "*")
            : relation(decoded.componentId, decoded.targetId as any);
        expect(reencoded).toBe(id);
      }),
      pbtAssertOptions,
    );
  });

  it("decodeRelationRaw is consistent with decodeRelationId for valid relations", () => {
    fc.assert(
      fc.property(componentIdArb, targetArb, (comp, target) => {
        const id = relation(comp, target as any);
        const raw = decodeRelationRaw(id);
        expect(raw).not.toBeNull();
        expect(raw!.componentId).toBe(comp as number);

        if (target === "*") {
          expect(raw!.targetId).toBe(0);
        } else {
          expect(raw!.targetId).toBe(target as number);
        }
      }),
      pbtAssertOptions,
    );
  });

  it("getDetailedIdType / getIdType agree with relation shape", () => {
    fc.assert(
      fc.property(componentIdArb, targetArb, (comp, target) => {
        const id = relation(comp, target as any);
        const detailed = getDetailedIdType(id);
        const coarse = getIdType(id);

        if (target === "*") {
          expect(detailed.type).toBe("wildcard-relation");
          expect(coarse).toBe("wildcard-relation");
          expect(detailed.componentId).toBe(comp);
        } else if (isEntityId(target as EntityId)) {
          expect(detailed.type).toBe("entity-relation");
          expect(coarse).toBe("entity-relation");
          expect(detailed.componentId).toBe(comp);
          expect(detailed.targetId).toBe(target);
        } else {
          expect(detailed.type).toBe("component-relation");
          expect(coarse).toBe("component-relation");
          expect(detailed.componentId).toBe(comp);
          expect(detailed.targetId).toBe(target);
        }
      }),
      pbtAssertOptions,
    );
  });

  it("rejects invalid relation constructors", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: COMPONENT_ID_MAX + 1, max: ENTITY_ID_START + 100 }),
          fc.integer({ min: -1000, max: -1 }),
        ),
        entityIdArb,
        (badComp, target) => {
          expect(() => relation(badComp as ComponentId, target)).toThrow();
        },
      ),
      pbtAssertOptions,
    );

    fc.assert(
      fc.property(
        componentIdArb,
        fc.oneof(fc.constant(-1), fc.integer({ min: -10_000, max: -1 }), fc.constant(Number.NaN)),
        (comp, badTarget) => {
          expect(() => relation(comp, badTarget as any)).toThrow();
        },
      ),
      pbtAssertOptions,
    );
  });

  it("non-relation IDs are not classified as relations", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: COMPONENT_ID_MAX }),
          fc.integer({ min: ENTITY_ID_START, max: ENTITY_ID_START + 10_000 }),
          fc.constant(0),
        ),
        (id) => {
          const branded = id as EntityId;
          expect(isRelationId(branded)).toBe(false);
          expect(isAnyRelation(branded)).toBe(false);
          expect(isWildcardRelationId(branded)).toBe(false);
          expect(decodeRelationRaw(branded)).toBeNull();
          expect(getComponentIdFromRelationId(branded)).toBeUndefined();
          expect(getTargetIdFromRelationId(branded)).toBeUndefined();
          if (isComponentId(branded)) {
            expect(getIdType(branded)).toBe("component");
          } else if (isEntityId(branded)) {
            expect(getIdType(branded)).toBe("entity");
          }
        },
      ),
      pbtAssertOptions,
    );
  });
});
