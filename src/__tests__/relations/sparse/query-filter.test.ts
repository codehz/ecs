import { describe, expect, it } from "bun:test";

import { component, relation } from "../../../entity";
import { World } from "../../../world/world";

describe("Sparse query filter correctness", () => {
  function setupTwoParents() {
    const world = new World();
    const Position = component<{ x: number }>();
    const ChildOf = component<{ weight: number }>({ sparse: true, exclusive: true });
    const p1 = world.new();
    const p2 = world.new();

    const c1 = world.new();
    world.set(c1, Position, { x: 1 });
    world.set(c1, relation(ChildOf, p1), { weight: 10 });

    const c2 = world.new();
    world.set(c2, Position, { x: 2 });
    world.set(c2, relation(ChildOf, p2), { weight: 20 });

    const c3 = world.new();
    world.set(c3, Position, { x: 3 });
    // no ChildOf

    world.sync();
    return { world, Position, ChildOf, p1, p2, c1, c2, c3 };
  }

  it("getEntities / forEach / iterate / getEntitiesWithComponents agree on specific target", () => {
    const { world, Position, ChildOf, p1, c1, c2, c3 } = setupTwoParents();
    const relP1 = relation(ChildOf, p1);
    using query = world.createQuery([relP1]);

    const fromGet = query
      .getEntities()
      .slice()
      .sort((a, b) => a - b);

    const fromForEach: number[] = [];
    query.forEach([relP1], (entity) => {
      fromForEach.push(entity);
    });
    fromForEach.sort((a, b) => a - b);

    const fromIterate: number[] = [];
    for (const [entity] of query.iterate([relP1])) {
      fromIterate.push(entity);
    }
    fromIterate.sort((a, b) => a - b);

    const fromWith = query
      .getEntitiesWithComponents([relP1])
      .map((r) => r.entity)
      .sort((a, b) => a - b);

    expect(fromGet).toEqual([c1]);
    expect(fromForEach).toEqual([c1]);
    expect(fromIterate).toEqual([c1]);
    expect(fromWith).toEqual([c1]);
    expect(fromGet).not.toContain(c2);
    expect(fromGet).not.toContain(c3);

    // Combined with Position
    using q2 = world.createQuery([Position, relP1]);
    expect(q2.getEntities()).toEqual([c1]);
  });

  it("forEach yields specific sparse relation payload (not wildcard shape)", () => {
    const { world, ChildOf, p1, c1 } = setupTwoParents();
    const relP1 = relation(ChildOf, p1);
    using query = world.createQuery([relP1]);

    const seen: Array<{ entity: number; data: { weight: number } }> = [];
    query.forEach([relP1], (entity, data) => {
      seen.push({ entity, data });
    });

    expect(seen).toEqual([{ entity: c1, data: { weight: 10 } }]);
  });

  it("getComponentData works for specific sparse relations", () => {
    const { world, ChildOf, p1 } = setupTwoParents();
    const relP1 = relation(ChildOf, p1);
    using query = world.createQuery([relP1]);

    const data = query.getComponentData(relP1);
    expect(data).toEqual([{ weight: 10 }]);
  });

  it("world.query matches createQuery for specific sparse target", () => {
    const { world, ChildOf, p1, c1 } = setupTwoParents();
    const relP1 = relation(ChildOf, p1);

    expect(world.query([relP1])).toEqual([c1]);

    const withData = world.query([relP1], true);
    expect(withData).toEqual([{ entity: c1, components: [{ weight: 10 }] }]);
  });

  it("negative specific sparse excludes only matching targets", () => {
    const { world, Position, ChildOf, p1, p2, c1, c2, c3 } = setupTwoParents();
    using query = world.createQuery([Position], {
      negativeComponentTypes: [relation(ChildOf, p1)],
    });

    const entities = query
      .getEntities()
      .slice()
      .sort((a, b) => a - b);
    expect(entities).toContain(c2);
    expect(entities).toContain(c3);
    expect(entities).not.toContain(c1);

    // forEach agrees
    const fromForEach: number[] = [];
    query.forEach([Position], (e) => fromForEach.push(e));
    expect(fromForEach.sort((a, b) => a - b)).toEqual(entities);

    // p2 is not excluded
    expect(world.has(c2, relation(ChildOf, p2))).toBe(true);
  });

  it("negative wildcard sparse excludes any ChildOf", () => {
    const { world, Position, ChildOf, c1, c2, c3 } = setupTwoParents();
    using query = world.createQuery([Position], {
      negativeComponentTypes: [relation(ChildOf, "*")],
    });

    const entities = query.getEntities();
    expect(entities).toEqual([c3]);
    expect(entities).not.toContain(c1);
    expect(entities).not.toContain(c2);
  });

  it("void sparse relation payload is readable via forEach", () => {
    const world = new World();
    const ChildOf = component({ sparse: true, exclusive: true });
    const parent = world.new();
    const child = world.new();
    world.set(child, relation(ChildOf, parent));
    world.sync();

    const rel = relation(ChildOf, parent);
    using query = world.createQuery([rel]);
    const payloads: unknown[] = [];
    query.forEach([rel], (_e, data) => {
      payloads.push(data);
    });
    expect(query.getEntities()).toEqual([child]);
    expect(payloads).toEqual([undefined]);
  });

  it("exclusive switch updates specific-target queries across APIs", () => {
    const world = new World();
    const ChildOf = component({ sparse: true, exclusive: true });
    const p1 = world.new();
    const p2 = world.new();
    const entity = world.new();

    using q1 = world.createQuery([relation(ChildOf, p1)]);
    using q2 = world.createQuery([relation(ChildOf, p2)]);

    world.set(entity, relation(ChildOf, p1));
    world.sync();
    expect(q1.getEntities()).toEqual([entity]);
    expect(q2.getEntities()).toEqual([]);

    const forEachP1: number[] = [];
    q1.forEach([relation(ChildOf, p1)], (e) => forEachP1.push(e));
    expect(forEachP1).toEqual([entity]);

    world.set(entity, relation(ChildOf, p2));
    world.sync();
    expect(q1.getEntities()).toEqual([]);
    expect(q2.getEntities()).toEqual([entity]);

    const forEachP2: number[] = [];
    q2.forEach([relation(ChildOf, p2)], (e) => forEachP2.push(e));
    expect(forEachP2).toEqual([entity]);
  });
});
