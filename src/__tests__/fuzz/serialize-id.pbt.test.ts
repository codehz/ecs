import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import {
  COMPONENT_ID_MAX,
  ENTITY_ID_START,
  component,
  createComponentId,
  createEntityId,
  relation,
  type ComponentId,
  type EntityId,
} from "../../entity";
import {
  decodeSerializedId,
  encodeEntityId,
  encodeEntityIdCached,
  type SerializedEntityId,
} from "../../storage/serialization";
import { pbtAssertOptions } from "./config";

// Named once at module load — component name registry is process-global.
const NamedA = component({ name: `pbt-ser-A-${Date.now()}` });
const NamedB = component({ name: `pbt-ser-B-${Date.now()}` });

const anonComponentArb = fc.integer({ min: 1, max: COMPONENT_ID_MAX }).map((id) => createComponentId(id));
const entityIdArb = fc.integer({ min: ENTITY_ID_START, max: ENTITY_ID_START + 50_000 }).map((id) => createEntityId(id));

const anonEncodableIdArb = fc.oneof(
  anonComponentArb,
  entityIdArb,
  fc
    .tuple(anonComponentArb, fc.oneof(fc.constant("*" as const), anonComponentArb, entityIdArb))
    .map(([c, t]) => relation(c, t as any)),
);

const namedEncodableIdArb = fc.oneof(
  fc.constant(NamedA),
  fc.constant(NamedB),
  entityIdArb,
  fc.constant(relation(NamedA, "*")),
  fc.constant(relation(NamedB, "*")),
  entityIdArb.map((e) => relation(NamedA, e)),
  entityIdArb.map((e) => relation(NamedB, e)),
  fc.constant(relation(NamedA, NamedB)),
  fc.constant(relation(NamedB, NamedA)),
);

describe("PBT: serialize ID codec", () => {
  it("encode → decode round-trips anonymous (numeric) IDs", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      fc.assert(
        fc.property(anonEncodableIdArb, (id) => {
          const encoded = encodeEntityId(id);
          const decoded = decodeSerializedId(encoded);
          expect(decoded).toBe(id);

          // Cached path must match uncached
          const cache = new Map<EntityId<any>, SerializedEntityId>();
          expect(encodeEntityIdCached(id, cache)).toEqual(encoded);
          expect(encodeEntityIdCached(id, cache)).toEqual(encoded);
          expect(decodeSerializedId(encodeEntityIdCached(id, cache))).toBe(id);
        }),
        pbtAssertOptions,
      );
    } finally {
      console.warn = warn;
    }
  });

  it("encode → decode round-trips named components and their relations", () => {
    fc.assert(
      fc.property(namedEncodableIdArb, (id) => {
        const encoded = encodeEntityId(id);
        const decoded = decodeSerializedId(encoded);
        expect(decoded).toBe(id);
      }),
      pbtAssertOptions,
    );
  });

  it("numeric SerializedEntityId is identity under decode", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: COMPONENT_ID_MAX }),
          fc.integer({ min: ENTITY_ID_START, max: ENTITY_ID_START + 10_000 }),
          // valid relation numbers produced by relation()
          fc
            .tuple(
              fc.integer({ min: 1, max: COMPONENT_ID_MAX }),
              fc.integer({ min: ENTITY_ID_START, max: ENTITY_ID_START + 1000 }),
            )
            .map(([c, t]) => relation(createComponentId(c), createEntityId(t)) as number),
        ),
        (n) => {
          expect(decodeSerializedId(n)).toBe(n as EntityId);
        },
      ),
      pbtAssertOptions,
    );
  });

  it("named component string form decodes to the registered id", () => {
    const encodedA = encodeEntityId(NamedA as ComponentId);
    const encodedB = encodeEntityId(NamedB as ComponentId);
    expect(typeof encodedA === "string" || typeof encodedA === "number").toBe(true);
    expect(decodeSerializedId(encodedA)).toBe(NamedA);
    expect(decodeSerializedId(encodedB)).toBe(NamedB);
  });

  it("unknown component name throws", () => {
    expect(() => decodeSerializedId(`no-such-component-${Date.now()}-xyz`)).toThrow(/Unknown component name/);
    expect(() => decodeSerializedId({ component: `no-such-rel-${Date.now()}-xyz`, target: "*" })).toThrow(
      /Unknown component name/,
    );
  });
});
